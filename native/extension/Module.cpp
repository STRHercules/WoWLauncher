// WarcraftXL inline chat textures for build 12340. GPL-3.0-or-later.
#include "wxl/PluginApi.h"
#include "engine/events/Event.hpp"
#include "game/Gx.hpp"
#include "game/Script.hpp"
#include <windows.h>
#include <bcrypt.h>
#include <d3d9.h>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <regex>
#include <string>
#include <thread>
#include <vector>

namespace
{
    namespace script = wxl::game::script;
    constexpr uint32_t Magic = 0x31484345;
    constexpr uint32_t FrameBytes = 320 * 180 * 4;
    constexpr uint32_t MaxResponse = 8 * (FrameBytes + 20) + 32768 + 8;
    struct Slot
    {
        std::string id;
        bool animate = false;
        DWORD visibleAt = 0;
        DWORD receivedAt = 0;
        uint64_t expiresAt = 0;
        int state = 0;
        uint64_t version = 0;
        uint64_t uploaded = 0;
        std::vector<uint8_t> pixels;
        IDirect3DTexture9* texture = nullptr;
    };
    std::array<Slot, 8> slots;
    std::mutex mutex;
    std::atomic<bool> inWorld{false}, stop{false}, done{true};
    // WXL extensions are process-lifetime; an active thread must not terminate the game during CRT teardown.
    std::thread* worker = nullptr;
    std::string ticket, upload, result;
    std::vector<std::string> cancellations;
    std::filesystem::path directory;
    std::string origin;
    bool deviceLost = false;
    IDirect3DTexture9* blank = nullptr;
    using BindFn = HRESULT(WINAPI*)(IDirect3DDevice9*, DWORD, IDirect3DBaseTexture9*);
    BindFn originalBind = nullptr;
    script::ValidateCallbackFn originalValidate = nullptr;
    script::off::FrameScriptRegisterFunctionFn originalRegister = nullptr;
    WXL_Api const* api = nullptr;
    void* registeredContext = nullptr;

    bool SafeId(std::string const& value)
    {
        return value.size() == 32 && value.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-") == std::string::npos;
    }
    bool SafeMediaId(std::string const& value)
    {
        return SafeId(value) || std::regex_match(value, std::regex(R"(avatar_[0-9]{1,10})"));
    }
    std::string String(void* state, int index)
    {
        if (!script::IsString(state, index)) return {};
        char const* value = script::ToString(state, index);
        return value ? std::string(value) : std::string();
    }
    int Place(void* state)
    {
        if (script::ArgCount(state) != 11) return 0;
        int slot = static_cast<int>(script::ToNumber(state, 1)) - 1;
        std::string id = String(state, 2);
        if (slot < 0 || slot >= 8 || !SafeMediaId(id)) return 0;
        std::lock_guard lock(mutex);
        auto& item = slots[slot];
        if (item.id != id) { item.id = id; item.state = 0; item.pixels.clear(); }
        item.animate = script::ToNumber(state, 11) != 0;
        item.visibleAt = GetTickCount();
        return 0;
    }
    int Hide(void* state)
    {
        int slot = static_cast<int>(script::ToNumber(state, 1)) - 1;
        if (slot >= 0 && slot < 8) { std::lock_guard lock(mutex); slots[slot].visibleAt = 0; slots[slot].state = 0; }
        return 0;
    }
    int Authorize(void* state)
    {
        std::string value = String(state, 1);
        if (SafeId(value)) { std::lock_guard lock(mutex); ticket = value; }
        return 0;
    }
    int Upload(void* state)
    {
        std::string value = String(state, 1), conversation = String(state, 2);
        if (SafeId(value) && std::regex_match(conversation, std::regex(R"((dm:[A-Za-z0-9_.-]{3,20}|group:[0-9]{1,10}))")))
        { std::lock_guard lock(mutex); ticket = value; upload = conversation; }
        return 0;
    }
    int Cancel(void* state)
    {
        std::string id = String(state, 1);
        if (SafeId(id)) { std::lock_guard lock(mutex); if (cancellations.size() < 8) cancellations.push_back(id); }
        return 0;
    }
    int Result(void* state)
    {
        std::lock_guard lock(mutex);
        script::PushString(state, result.c_str()); result.clear();
        return 1;
    }
    int Status(void* state)
    {
        int slot = static_cast<int>(script::ToNumber(state, 1)) - 1;
        int value = 0;
        if (slot >= 0 && slot < 8)
        {
            std::lock_guard lock(mutex);
            FILETIME timestamp{}; GetSystemTimeAsFileTime(&timestamp);
            uint64_t now = ((uint64_t(timestamp.dwHighDateTime) << 32 | timestamp.dwLowDateTime) - 116444736000000000ULL) / 10000;
            if (GetTickCount() - slots[slot].receivedAt < 1500) value = slots[slot].expiresAt && slots[slot].expiresAt <= now ? 2 : slots[slot].state;
        }
        script::PushNumber(state, value);
        return 1;
    }
    std::array<std::pair<char const*, script::Function>, 7> const functions{{
        {"EsteriaChatMediaPlace", Place}, {"EsteriaChatMediaHide", Hide}, {"EsteriaChatMediaAuthorize", Authorize},
        {"EsteriaChatMediaUpload", Upload}, {"EsteriaChatMediaCancel", Cancel}, {"EsteriaChatMediaResult", Result}, {"EsteriaChatMediaStatus", Status}
    }};
    void __cdecl Validate(uintptr_t pointer)
    {
        for (auto const& entry : functions) if (pointer == reinterpret_cast<uintptr_t>(entry.second)) return;
        originalValidate(pointer);
    }
    void __cdecl Register(char const* name, script::Function function)
    {
        originalRegister(name, function);
        if (name && std::strcmp(name, "GetBuildInfo") == 0) registeredContext = nullptr;
    }

    bool Transfer(HANDLE pipe, void* memory, DWORD bytes, bool writing)
    {
        auto* data = static_cast<uint8_t*>(memory);
        while (bytes && !stop)
        {
            DWORD actual = 0;
            bool ok = writing ? WriteFile(pipe, data, bytes, &actual, nullptr) != 0 : ReadFile(pipe, data, bytes, &actual, nullptr) != 0;
            if (!ok || actual == 0 || actual > bytes) return false;
            data += actual; bytes -= actual;
        }
        return bytes == 0;
    }
    uint32_t Read32(std::vector<uint8_t> const& data, size_t& position)
    {
        if (position + 4 > data.size()) throw std::runtime_error("IPC bounds");
        uint32_t value; std::memcpy(&value, data.data() + position, 4); position += 4;
        return value;
    }
    void RunHelper()
    {
        std::array<uint8_t, 16> random{};
        if (BCryptGenRandom(nullptr, random.data(), static_cast<ULONG>(random.size()), BCRYPT_USE_SYSTEM_PREFERRED_RNG) < 0) { done = true; return; }
        std::wstring nonce;
        constexpr wchar_t digits[] = L"0123456789abcdef";
        for (uint8_t value : random) { nonce += digits[value >> 4]; nonce += digits[value & 15]; }
        auto executable = directory / L"EsteriaChatHelper.exe";
        std::wstring command = L"\"" + executable.wstring() + L"\" " + std::to_wstring(GetCurrentProcessId()) + L" " + nonce + L" " + std::wstring(origin.begin(), origin.end()) + L" 1";
        STARTUPINFOW startup{}; startup.cb = sizeof(startup); startup.dwFlags = STARTF_USESHOWWINDOW; startup.wShowWindow = SW_HIDE;
        PROCESS_INFORMATION process{};
        if (!CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, FALSE, CREATE_NO_WINDOW, nullptr, directory.c_str(), &startup, &process)) { done = true; return; }
        CloseHandle(process.hThread);
        std::wstring name = L"\\\\.\\pipe\\EsteriaChat-" + std::to_wstring(GetCurrentProcessId()) + L"-" + nonce;
        HANDLE pipe = INVALID_HANDLE_VALUE;
        for (int i = 0; i < 100 && !stop; ++i)
        {
            pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, 0, nullptr);
            if (pipe != INVALID_HANDLE_VALUE) break;
            Sleep(50);
        }
        ULONG serverPid = 0;
        if (pipe != INVALID_HANDLE_VALUE && GetNamedPipeServerProcessId(pipe, &serverPid) && serverPid == process.dwProcessId)
        {
            while (!stop)
            {
                std::array<std::string, 8> identities;
                std::string request;
                {
                    std::lock_guard lock(mutex);
                    request = "{\"ticket\":\"" + ticket + "\",\"visible\":[";
                    bool comma = false;
                    for (int i = 0; i < 8; ++i)
                    {
                        auto const& slot = slots[i];
                        if (!SafeMediaId(slot.id) || !slot.visibleAt || GetTickCount() - slot.visibleAt > 500) continue;
                        identities[i] = slot.id;
                        request += (comma ? "," : "") + std::string("{\"slot\":") + std::to_string(i + 1) + ",\"id\":\"" + slot.id + "\",\"animate\":" + (slot.animate ? "true}" : "false}");
                        comma = true;
                    }
                    request += "]";
                    if (!upload.empty()) { request += ",\"upload\":\"" + upload + "\""; upload.clear(); }
                    if (!cancellations.empty()) { request += ",\"cancel\":\"" + cancellations.front() + "\""; cancellations.erase(cancellations.begin()); }
                    request += "}";
                }
                uint32_t header[2]{Magic, static_cast<uint32_t>(request.size())};
                if (!Transfer(pipe, header, 8, true) || !Transfer(pipe, request.data(), header[1], true) || !Transfer(pipe, header, 8, false) ||
                    header[0] != Magic || header[1] > MaxResponse || header[1] < 8) break;
                std::vector<uint8_t> response(header[1]);
                if (!Transfer(pipe, response.data(), header[1], false)) break;
                try
                {
                    size_t position = 0;
                    uint32_t resultBytes = Read32(response, position);
                    if (resultBytes > 32768 || position + resultBytes > response.size()) throw std::runtime_error("IPC result bounds");
                    std::string uploadResult(reinterpret_cast<char const*>(response.data() + position), resultBytes); position += resultBytes;
                    uint32_t count = Read32(response, position);
                    if (count > 8) throw std::runtime_error("IPC frame count");
                    std::lock_guard lock(mutex);
                    if (!uploadResult.empty()) result = uploadResult;
                    for (auto& slot : slots) slot.state = 0;
                    for (uint32_t i = 0; i < count; ++i)
                    {
                        uint32_t index = Read32(response, position), state = Read32(response, position), size = Read32(response, position);
                        uint64_t expires = Read32(response, position); expires |= uint64_t(Read32(response, position)) << 32;
                        if (index < 1 || index > 8 || state > 2 || (size != FrameBytes && size != 0) || position + size > response.size())
                            throw std::runtime_error("IPC frame bounds");
                        auto& slot = slots[index - 1];
                        if (slot.id == identities[index - 1])
                        {
                            if (size || state != 1) { slot.pixels.assign(response.begin() + position, response.begin() + position + size); ++slot.version; }
                            slot.state = state == 1 && slot.pixels.empty() ? 0 : static_cast<int>(state); slot.receivedAt = GetTickCount(); slot.expiresAt = expires;
                        }
                        position += size;
                    }
                    if (position != response.size()) throw std::runtime_error("IPC trailing bytes");
                }
                catch (...) { break; }
                Sleep(10);
            }
        }
        if (pipe != INVALID_HANDLE_VALUE) CloseHandle(pipe);
        if (WaitForSingleObject(process.hProcess, 2000) == WAIT_TIMEOUT) TerminateProcess(process.hProcess, 1);
        CloseHandle(process.hProcess);
        { std::lock_guard lock(mutex); for (auto& slot : slots) { slot.state = 0; slot.pixels.clear(); } ticket.clear(); }
        done = true;
    }

    int Marker(IDirect3DBaseTexture9* base)
    {
        if (!base || base->GetType() != D3DRTYPE_TEXTURE) return -1;
        auto* texture = static_cast<IDirect3DTexture9*>(base);
        D3DSURFACE_DESC desc{};
        if (FAILED(texture->GetLevelDesc(0, &desc)) || desc.Width != 8 || desc.Height != 8 || desc.Format != D3DFMT_A8R8G8B8) return -1;
        D3DLOCKED_RECT locked{};
        if (FAILED(texture->LockRect(0, &locked, nullptr, D3DLOCK_READONLY))) return -1;
        auto const* pixels = static_cast<uint32_t const*>(locked.pBits);
        int slot = pixels[0] == 0x00A133EC && pixels[1] == 0x00B08808 && pixels[2] >= 1 && pixels[2] <= 8 ? static_cast<int>(pixels[2]) - 1 : -1;
        texture->UnlockRect(0);
        return slot;
    }
    HRESULT WINAPI Bind(IDirect3DDevice9* device, DWORD stage, IDirect3DBaseTexture9* base)
    {
        int index = Marker(base);
        if (index < 0 || stage != 0 || deviceLost) return originalBind(device, stage, base);
        IDirect3DTexture9* replacement = blank;
        {
            std::lock_guard lock(mutex);
            auto const& slot = slots[index];
            FILETIME timestamp{}; GetSystemTimeAsFileTime(&timestamp);
            uint64_t now = ((uint64_t(timestamp.dwHighDateTime) << 32 | timestamp.dwLowDateTime) - 116444736000000000ULL) / 10000;
            if (slot.state == 1 && GetTickCount() - slot.receivedAt < 1500 && slot.visibleAt && GetTickCount() - slot.visibleAt < 500 && slot.uploaded == slot.version)
                if (slot.expiresAt > now) replacement = slot.texture;
        }
        return originalBind(device, stage, replacement ? replacement : base);
    }
    void ReleaseTextures()
    {
        for (auto& slot : slots) if (slot.texture) { slot.texture->Release(); slot.texture = nullptr; slot.uploaded = 0; }
        if (blank) { blank->Release(); blank = nullptr; }
    }
    void Update(void*, void const*)
    {
        void* context = wxl::game::Native<script::off::FrameScriptGetContextFn>(script::off::kFrameScriptGetContext)();
        if (context && context != registeredContext)
        {
            for (auto const& entry : functions) script::Register(entry.first, entry.second);
            registeredContext = context;
        }
        if (inWorld && done)
        {
            bool needed;
            { std::lock_guard lock(mutex); needed = !ticket.empty() || !upload.empty(); }
            if (needed) { if (worker) { worker->join(); delete worker; } stop = false; done = false; worker = new std::thread(RunHelper); }
        }
        auto* device = static_cast<IDirect3DDevice9*>(wxl::game::gx::RawDevice());
        if (!device || deviceLost) return;
        if (!originalBind)
        {
            auto** table = *reinterpret_cast<void***>(device);
            if (!api->HookAttach("EsteriaChat.D3DSetTexture", reinterpret_cast<uintptr_t>(table[65]), reinterpret_cast<void*>(Bind), reinterpret_cast<void**>(&originalBind), 0)) return;
        }
        std::lock_guard lock(mutex);
        if (!blank && SUCCEEDED(device->CreateTexture(1, 1, 1, D3DUSAGE_DYNAMIC, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &blank, nullptr)))
        {
            D3DLOCKED_RECT locked{};
            if (SUCCEEDED(blank->LockRect(0, &locked, nullptr, D3DLOCK_DISCARD))) { std::memset(locked.pBits, 0, 4); blank->UnlockRect(0); }
        }
        for (auto& slot : slots)
        {
            FILETIME timestamp{}; GetSystemTimeAsFileTime(&timestamp);
            uint64_t now = ((uint64_t(timestamp.dwHighDateTime) << 32 | timestamp.dwLowDateTime) - 116444736000000000ULL) / 10000;
            if (slot.expiresAt && slot.expiresAt <= now)
            {
                slot.state = 2; slot.pixels.clear();
                if (slot.texture) { slot.texture->Release(); slot.texture = nullptr; slot.uploaded = 0; }
                continue;
            }
            if (slot.state != 1 || slot.pixels.size() != FrameBytes || slot.uploaded == slot.version) continue;
            if (!slot.texture && FAILED(device->CreateTexture(320, 180, 1, D3DUSAGE_DYNAMIC, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &slot.texture, nullptr))) continue;
            D3DLOCKED_RECT locked{};
            if (FAILED(slot.texture->LockRect(0, &locked, nullptr, D3DLOCK_DISCARD))) continue;
            for (int y = 0; y < 180; ++y) std::memcpy(static_cast<uint8_t*>(locked.pBits) + y * locked.Pitch, slot.pixels.data() + y * 320 * 4, 320 * 4);
            slot.texture->UnlockRect(0); slot.uploaded = slot.version;
        }
    }
    void Lost(void*, void const*) { std::lock_guard lock(mutex); deviceLost = true; ReleaseTextures(); }
    void Reset(void*, void const*) { deviceLost = false; }
    void Enter(void*, void const*) { inWorld = true; }
    void Leave(void*, void const*)
    {
        inWorld = false; stop = true;
        if (worker && worker->joinable()) CancelSynchronousIo(worker->native_handle());
        std::lock_guard lock(mutex);
        for (auto& slot : slots) { slot.visibleAt = 0; slot.state = 0; slot.id.clear(); slot.pixels.clear(); }
        ticket.clear(); upload.clear(); cancellations.clear(); result.clear();
    }
    bool HasExpectedClientImage()
    {
        wchar_t path[MAX_PATH]{};
        if (!GetModuleFileNameW(nullptr, path, MAX_PATH)) return false;
        std::ifstream file(path, std::ios::binary);
        BCRYPT_ALG_HANDLE algorithm = nullptr; BCRYPT_HASH_HANDLE hash = nullptr;
        if (!file || BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) < 0) return false;
        bool ok = BCryptCreateHash(algorithm, &hash, nullptr, 0, nullptr, 0, 0) >= 0;
        std::array<char, 65536> chunk{};
        while (ok && file) { file.read(chunk.data(), chunk.size()); ok = BCryptHashData(hash, reinterpret_cast<PUCHAR>(chunk.data()), static_cast<ULONG>(file.gcount()), 0) >= 0; }
        std::array<uint8_t, 32> digest{};
        ok = ok && BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0) >= 0;
        if (hash) BCryptDestroyHash(hash); BCryptCloseAlgorithmProvider(algorithm, 0);
        std::string hex; constexpr char digits[] = "0123456789abcdef";
        for (uint8_t value : digest) { hex += digits[value >> 4]; hex += digits[value & 15]; }
        return ok && hex == EXPECTED_CLIENT_SHA256;
    }
}

WXL_PluginInfo const* __cdecl WXL_Query()
{
    static WXL_PluginInfo const info{sizeof(WXL_PluginInfo), WXL_API_VERSION, "wxl-esteria-chat", 100, WXL_CLIENT_BUILD};
    return &info;
}
int __cdecl WXL_Load(WXL_Api const* value)
{
    if (!value || value->apiVersion != WXL_API_VERSION || value->structSize < offsetof(WXL_Api, HookAttachByName) + sizeof(value->HookAttachByName) ||
        !value->Subscribe || !value->HookAttach || !value->HookAttachByName || !HasExpectedClientImage()) return 0;
    api = value;
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
        reinterpret_cast<LPCWSTR>(&WXL_Load), &module)) return 0;
    wchar_t path[MAX_PATH]{}; if (!GetModuleFileNameW(module, path, MAX_PATH)) return 0;
    directory = std::filesystem::path(path).parent_path();
    wchar_t configured[2048]{};
    GetPrivateProfileStringW(L"Chat", L"ApiOrigin", L"", configured, 2048, (directory / L"chat-media.ini").c_str());
    std::wstring wide(configured);
    for (wchar_t c : wide) { if (c > 127) return 0; origin += static_cast<char>(c); }
    if (!std::regex_match(origin, std::regex(R"((https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?|http://(127\.0\.0\.1|localhost)(:[0-9]{1,5})?/?))"))) return 0;
    if (!api->HookAttachByName("Lua.ValidateFunctionPointer", reinterpret_cast<void*>(Validate), reinterpret_cast<void**>(&originalValidate), 0) ||
        !api->HookAttachByName("Lua.RegisterFunction", reinterpret_cast<void*>(Register), reinterpret_cast<void**>(&originalRegister), 0)) return 0;
    api->Subscribe(static_cast<uint32_t>(wxl::events::Event::OnUpdate), Update, nullptr);
    api->Subscribe(static_cast<uint32_t>(wxl::events::Event::OnDeviceLost), Lost, nullptr);
    api->Subscribe(static_cast<uint32_t>(wxl::events::Event::OnDeviceReset), Reset, nullptr);
    api->Subscribe(static_cast<uint32_t>(wxl::events::Event::OnWorldEnter), Enter, nullptr);
    api->Subscribe(static_cast<uint32_t>(wxl::events::Event::OnWorldLeave), Leave, nullptr);
    return 1;
}

#ifdef ESTERIA_CHAT_SELFTEST
#include <iostream>
#include <source_location>
namespace
{
    IDirect3DBaseTexture9* bound = nullptr;
    HRESULT WINAPI RecordBind(IDirect3DDevice9*, DWORD, IDirect3DBaseTexture9* value) { bound = value; return S_OK; }
    void Check(bool condition, std::source_location location = std::source_location::current())
    { if (!condition) throw std::runtime_error("Native selfcheck failed at line " + std::to_string(location.line())); }
}
int main()
{
    try
    {
        Check(WXL_Query()->clientBuild == 12340 && WXL_Load(nullptr) == 0);
        Check(!HasExpectedClientImage()); // A different executable must be refused.
        Check(SafeId(std::string(32, 'a')) && !SafeId("../file"));
        Check(SafeMediaId("avatar_12") && !SafeMediaId("https://example.org"));
        std::vector<uint8_t> bytes{1, 0, 0, 0}; size_t position = 0;
        Check(Read32(bytes, position) == 1);
        bool refused = false; try { Read32(bytes, position); } catch (...) { refused = true; }
        Check(refused);
        HWND window = CreateWindowExW(0, L"STATIC", L"Chat native selfcheck", WS_OVERLAPPED, 0, 0, 320, 240, nullptr, nullptr, nullptr, nullptr);
        Check(window != nullptr);
        IDirect3D9* d3d = Direct3DCreate9(D3D_SDK_VERSION); Check(d3d != nullptr);
        D3DPRESENT_PARAMETERS parameters{}; parameters.Windowed = TRUE; parameters.SwapEffect = D3DSWAPEFFECT_DISCARD; parameters.hDeviceWindow = window;
        parameters.BackBufferWidth = 320; parameters.BackBufferHeight = 180;
        IDirect3DDevice9* device = nullptr;
        Check(SUCCEEDED(d3d->CreateDevice(D3DADAPTER_DEFAULT, D3DDEVTYPE_HAL, window, D3DCREATE_SOFTWARE_VERTEXPROCESSING, &parameters, &device)));
        IDirect3DTexture9* marker = nullptr;
        Check(SUCCEEDED(device->CreateTexture(8, 8, 1, 0, D3DFMT_A8R8G8B8, D3DPOOL_MANAGED, &marker, nullptr)));
        D3DLOCKED_RECT data{}; Check(SUCCEEDED(marker->LockRect(0, &data, nullptr, 0)));
        auto* pixels = static_cast<uint32_t*>(data.pBits); pixels[0] = 0x00A133EC; pixels[1] = 0x00B08808; pixels[2] = 4; marker->UnlockRect(0);
        Check(Marker(marker) == 3);
        Check(SUCCEEDED(device->CreateTexture(320, 180, 1, D3DUSAGE_DYNAMIC, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &slots[3].texture, nullptr)));
        Check(SUCCEEDED(device->CreateTexture(1, 1, 1, D3DUSAGE_DYNAMIC, D3DFMT_A8R8G8B8, D3DPOOL_DEFAULT, &blank, nullptr)));
        originalBind = RecordBind;
        slots[3].state = 1; slots[3].visibleAt = GetTickCount(); slots[3].receivedAt = GetTickCount();
        slots[3].expiresAt = UINT64_MAX;
        Bind(device, 0, marker); Check(bound == slots[3].texture);
        slots[3].state = 0; Bind(device, 0, marker); Check(bound == blank);
        Bind(device, 1, marker); Check(bound == marker);
        Lost(nullptr, nullptr); Check(!blank && !slots[3].texture && deviceLost); Reset(nullptr, nullptr); Check(!deviceLost);
        marker->Release(); device->Release(); d3d->Release(); DestroyWindow(window);
        std::cout << "native selftest passed: ABI, image refusal, IPC bounds, D3D9 marker replacement, unavailable media and device reset release\n";
        return 0;
    }
    catch (std::exception const& error) { std::cerr << error.what() << '\n'; return 1; }
}
#endif
