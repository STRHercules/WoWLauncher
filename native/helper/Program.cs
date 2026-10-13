using System.Diagnostics;
using System.Drawing.Imaging;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

internal sealed class CachedImage : IDisposable
{
    public required Image Image;
    public required MemoryStream Stream;
    public long ExpiresAt;
    public long CheckedAt;
    public long UsedAt;
    public long Budget;
    public int Frames;
    public int[] Delays = [100];
    public void Dispose() { Image.Dispose(); Stream.Dispose(); }
}

internal static partial class Program
{
    const uint Magic = 0x31484345; // ECH1, versioned, bounded message framing.
    const int FrameWidth = 320, FrameHeight = 180;
    static readonly HttpClient Http = new(new HttpClientHandler { AllowAutoRedirect = false }) { Timeout = TimeSpan.FromSeconds(10) };
    static readonly Dictionary<string, CachedImage> Cache = [];
    static readonly Dictionary<int, string> LastFrames = [];
    static JsonObject Policy = new();
    static long PolicyChecked;
    static long CacheBytes;
    static string Ticket = "";
    static Uri Origin = null!;
    static JsonObject? UploadResult;
    static Task<JsonObject>? UploadTask;
    static int GamePid;
    static CancellationTokenSource Lifetime = new();
    static long Now => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    [LibraryImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static partial bool GetNamedPipeClientProcessId(nint pipe, out uint pid);

    [STAThread]
    static async Task Main(string[] args)
    {
        if (args.Length != 4 || !int.TryParse(args[0], out GamePid) || GamePid < 1 ||
            !Regex.IsMatch(args[1], "^[A-Za-z0-9_-]{32}$") || !Uri.TryCreate(args[2], UriKind.Absolute, out Origin!) ||
            (Origin.Scheme != "https" && !(Origin.Scheme == "http" && Origin.IsLoopback)) ||
            Origin.AbsolutePath != "/" || !string.IsNullOrEmpty(Origin.UserInfo) || args[3] != "1") return;
        try
        {
            var game = Process.GetProcessById(GamePid);
            _ = game.WaitForExitAsync().ContinueWith(_ => Lifetime.Cancel(), TaskScheduler.Default);
            using var pipe = new NamedPipeServerStream($"EsteriaChat-{GamePid}-{args[1]}", PipeDirection.InOut, 1,
                PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            await pipe.WaitForConnectionAsync(Lifetime.Token);
            if (!GetNamedPipeClientProcessId(pipe.SafePipeHandle.DangerousGetHandle(), out var client) || client != GamePid) return;
            while (pipe.IsConnected && !Lifetime.IsCancellationRequested)
            {
                var header = new byte[8]; await pipe.ReadExactlyAsync(header, Lifetime.Token);
                var size = BitConverter.ToInt32(header, 4);
                if (BitConverter.ToUInt32(header) != Magic || size < 2 || size > 32768) break;
                var bytes = new byte[size]; await pipe.ReadExactlyAsync(bytes, Lifetime.Token);
                var request = JsonNode.Parse(bytes)?.AsObject() ?? throw new InvalidDataException();
                if (request["ticket"]?.GetValue<string>() is { } token && Regex.IsMatch(token, "^[A-Za-z0-9_-]{32}$")) Ticket = token;
                if (request["stop"]?.GetValue<bool>() == true) break;
                var frames = new List<(int Slot, byte[] Bytes, int State, long Expires)>();
                try
                {
                    await RefreshPolicy();
                    Purge();
                    if (request["cancel"]?.GetValue<string>() is { } cancel && ValidMediaId(cancel))
                        await DeleteUpload(cancel);
                    if (request["upload"]?.GetValue<string>() is { } conversation && UploadTask == null)
                        UploadTask = PickUpload(conversation);
                    if (UploadTask?.IsCompleted == true) { UploadResult = await UploadTask; UploadTask = null; }
                    int animations = 0;
                    var visibleSlots = new HashSet<int>();
                    foreach (var node in (request["visible"] as JsonArray ?? new JsonArray()).Take(8))
                    {
                        var slot = node?["slot"]?.GetValue<int>() ?? 0;
                        var id = node?["id"]?.GetValue<string>() ?? "";
                        if (slot < 1 || slot > 8 || !ValidMediaId(id)) continue;
                        visibleSlots.Add(slot);
                        try
                        {
                            var image = await GetImage(id);
                            bool animate = node?["animate"]?.GetValue<bool>() == true && image.Frames > 1 && animations++ < Limit("MaxConcurrentAnimations");
                            int selected = FrameIndex(image, animate);
                            string signature = $"{id}:{selected}:{image.CheckedAt}";
                            bool changed = LastFrames.GetValueOrDefault(slot) != signature;
                            frames.Add((slot, changed ? Draw(image, selected) : [], 1, image.ExpiresAt)); LastFrames[slot] = signature;
                        }
                        catch (HttpRequestException error) when (error.StatusCode == System.Net.HttpStatusCode.Gone)
                        { LastFrames.Remove(slot); frames.Add((slot, [], 2, 0)); }
                        catch { LastFrames.Remove(slot); frames.Add((slot, [], 0, 0)); }
                    }
                    foreach (var hidden in LastFrames.Keys.Where(slot => !visibleSlots.Contains(slot)).ToArray()) LastFrames.Remove(hidden);
                }
                catch { PurgeAll(); }
                using var response = new MemoryStream();
                using (var writer = new BinaryWriter(response, Encoding.UTF8, true))
                {
                    var result = Encoding.UTF8.GetBytes(UploadResult?.ToJsonString() ?? ""); UploadResult = null;
                    writer.Write(result.Length); writer.Write(result); writer.Write(frames.Count);
                    foreach (var frame in frames)
                    { writer.Write(frame.Slot); writer.Write(frame.State); writer.Write(frame.Bytes.Length); writer.Write(frame.Expires); writer.Write(frame.Bytes); }
                }
                var body = response.ToArray();
                await pipe.WriteAsync(BitConverter.GetBytes(Magic), Lifetime.Token);
                await pipe.WriteAsync(BitConverter.GetBytes(body.Length), Lifetime.Token);
                await pipe.WriteAsync(body, Lifetime.Token);
                await pipe.FlushAsync(Lifetime.Token);
            }
        }
        catch { /* Broken IPC, game exit or malformed input ends this isolated decoder. */ }
        finally { PurgeAll(); Http.Dispose(); }
    }
    static bool ValidMediaId(string id) => Regex.IsMatch(id, "^([A-Za-z0-9_-]{32}|avatar_[0-9]{1,10})$");
    static long Limit(string key) => Policy[key]?.GetValue<long>() ?? throw new InvalidDataException("Missing media capability");
    static Uri Address(string path) => new(Origin, path);
    static async Task RefreshPolicy()
    {
        if (Now - PolicyChecked < 30000) return;
        using var request = new HttpRequestMessage(HttpMethod.Get, Address("/api/v2/social/chat/capabilities"));
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, Lifetime.Token);
        response.EnsureSuccessStatusCode();
        var data = await ReadBounded(response, 32768);
        var root = JsonNode.Parse(data)?.AsObject() ?? throw new InvalidDataException();
        if (root["protocolVersion"]?.GetValue<int>() != 1 || root["features"]?["attachments"]?.GetValue<bool>() != true)
            throw new InvalidDataException("Attachments disabled or incompatible");
        Policy = root["media"]!.AsObject();
        foreach (var key in new[] { "CacheMaxBytes", "MaxUploadBytes", "MaxDimension", "MaxFrames", "MaxDecodedFramePixels", "MaxDecodedPixels", "MaxConcurrentAnimations" })
            if (Limit(key) < 1) throw new InvalidDataException("Invalid media policy");
        PolicyChecked = Now;
    }
    static async Task<byte[]> ReadBounded(HttpResponseMessage response, long limit)
    {
        if (response.Content.Headers.ContentLength > limit) throw new InvalidDataException("Response too large");
        using var stream = await response.Content.ReadAsStreamAsync(Lifetime.Token);
        using var buffer = new MemoryStream(); var chunk = new byte[65536];
        for (;;) { int read = await stream.ReadAsync(chunk, Lifetime.Token); if (read == 0) break;
            if (buffer.Length + read > limit) throw new InvalidDataException("Response too large"); buffer.Write(chunk, 0, read); }
        return buffer.ToArray();
    }
    static async Task<CachedImage> GetImage(string id)
    {
        if (Cache.TryGetValue(id, out var existing) && existing.ExpiresAt > Now && Now - existing.CheckedAt < 15000)
        { existing.UsedAt = Now; return existing; }
        Remove(id);
        using var request = new HttpRequestMessage(HttpMethod.Get, Address($"/api/v2/social/chat/attachments/{id}?preview=1"));
        request.Headers.Add("X-Chat-Helper", Ticket);
        using var response = await Http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, Lifetime.Token);
        response.EnsureSuccessStatusCode();
        if (!response.Headers.TryGetValues("X-Chat-Expires-At", out var values) || !long.TryParse(values.Single(), out var expires) || expires <= Now)
            throw new HttpRequestException("Attachment expired", null, System.Net.HttpStatusCode.Gone);
        var bytes = await ReadBounded(response, Limit("MaxUploadBytes"));
        var stream = new MemoryStream(bytes, false);
        Image? image = null;
        try
        {
            image = Image.FromStream(stream, false, true);
            int count = image.FrameDimensionsList.Contains(FrameDimension.Time.Guid) ? image.GetFrameCount(FrameDimension.Time) : 1;
            if (image.Width > Limit("MaxDimension") || image.Height > Limit("MaxDimension") || count > Limit("MaxFrames") ||
                (long)image.Width * image.Height > Limit("MaxDecodedPixels") || (long)image.Width * image.Height * count > Limit("MaxDecodedFramePixels"))
                throw new InvalidDataException("Decoded media limit");
            long budget = bytes.Length + (long)image.Width * image.Height * count * 4;
            if (budget > Limit("CacheMaxBytes")) throw new InvalidDataException("Cache limit");
            while (CacheBytes + budget > Limit("CacheMaxBytes")) Remove(Cache.MinBy(p => p.Value.UsedAt).Key);
            int[] delays = Enumerable.Repeat(100, count).ToArray();
            if (count > 1 && image.PropertyIdList.Contains(0x5100))
            {
                var raw = image.GetPropertyItem(0x5100)?.Value ?? [];
                for (int i = 0; i < count && i * 4 + 4 <= raw.Length; i++) delays[i] = Math.Clamp(BitConverter.ToInt32(raw, i * 4) * 10, 20, 60000);
            }
            if (delays.Sum(d => (long)d) > Limit("MaxAnimationDurationMs")) throw new InvalidDataException("Animation duration limit");
            var cached = new CachedImage { Image = image, Stream = stream, ExpiresAt = expires, CheckedAt = Now, UsedAt = Now, Budget = budget, Frames = count, Delays = delays };
            Cache.Add(id, cached); CacheBytes += budget; return cached;
        }
        catch { image?.Dispose(); stream.Dispose(); throw; }
    }
    static int FrameIndex(CachedImage image, bool animate)
    {
        int frame = 0;
        if (animate)
        {
            long position = Now % image.Delays.Sum(d => (long)d);
            while (frame < image.Frames - 1 && position >= image.Delays[frame]) position -= image.Delays[frame++];
        }
        return frame;
    }
    static byte[] Draw(CachedImage image, int frame)
    {
        if (image.Frames > 1) image.Image.SelectActiveFrame(FrameDimension.Time, frame);
        using var bitmap = new Bitmap(FrameWidth, FrameHeight, PixelFormat.Format32bppArgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            graphics.Clear(Color.Transparent);
            double scale = Math.Min((double)FrameWidth / image.Image.Width, (double)FrameHeight / image.Image.Height);
            int width = Math.Max(1, (int)(image.Image.Width * scale)), height = Math.Max(1, (int)(image.Image.Height * scale));
            graphics.DrawImage(image.Image, (FrameWidth - width) / 2, (FrameHeight - height) / 2, width, height);
        }
        var data = bitmap.LockBits(new Rectangle(0, 0, FrameWidth, FrameHeight), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try { var pixels = new byte[FrameWidth * FrameHeight * 4]; for (int y = 0; y < FrameHeight; y++) Marshal.Copy(data.Scan0 + y * data.Stride, pixels, y * FrameWidth * 4, FrameWidth * 4); return pixels; }
        finally { bitmap.UnlockBits(data); }
    }
    static Task<JsonObject> PickUpload(string conversation)
    {
        if (!Regex.IsMatch(conversation, "^(dm:[A-Za-z0-9_.-]{3,20}|group:[0-9]{1,10})$")) return Task.FromResult(new JsonObject { ["message"] = "Select a conversation first." });
        var completion = new TaskCompletionSource<JsonObject>();
        var picker = new Thread(() =>
        {
            try
            {
                using var dialog = new OpenFileDialog { Filter = "Chat images|*.png;*.jpg;*.jpeg;*.gif;*.webp", Multiselect = false, Title = "Attach image to chat" };
                if (dialog.ShowDialog() != DialogResult.OK) { completion.SetResult(new JsonObject { ["message"] = "Upload cancelled." }); return; }
                var file = new FileInfo(dialog.FileName);
                if (file.Length < 1 || file.Length > Limit("MaxUploadBytes")) throw new InvalidDataException("File exceeds upload limit");
                using var request = new HttpRequestMessage(HttpMethod.Post, Address($"/api/v2/social/chat/attachments?conversation={Uri.EscapeDataString(conversation)}"));
                request.Headers.Add("X-Chat-Helper", Ticket);
                using var stream = file.OpenRead(); request.Content = new StreamContent(stream);
                var extension = file.Extension.ToLowerInvariant();
                string mime = extension switch { ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif", ".webp" => "image/webp", _ => throw new InvalidDataException("Unsupported format") };
                request.Content.Headers.ContentType = new(mime);
                using var response = Http.SendAsync(request, Lifetime.Token).GetAwaiter().GetResult();
                var bytes = ReadBounded(response, 32768).GetAwaiter().GetResult();
                var result = JsonNode.Parse(bytes)?.AsObject() ?? throw new InvalidDataException();
                if (!response.IsSuccessStatusCode) throw new InvalidDataException(result["message"]?.GetValue<string>() ?? "Upload rejected");
                completion.SetResult(result);
            }
            catch { completion.TrySetResult(new JsonObject { ["message"] = "Upload failed. Retry or cancel; no message was sent." }); }
        }) { IsBackground = true };
        picker.SetApartmentState(ApartmentState.STA); picker.Start(); return completion.Task;
    }
    static async Task DeleteUpload(string id)
    {
        using var request = new HttpRequestMessage(HttpMethod.Delete, Address($"/api/v2/social/chat/attachments/{id}")); request.Headers.Add("X-Chat-Helper", Ticket);
        using var response = await Http.SendAsync(request, Lifetime.Token); response.EnsureSuccessStatusCode();
    }
    static void Remove(string id) { if (Cache.Remove(id, out var image)) { CacheBytes -= image.Budget; image.Dispose(); } }
    static void Purge() { foreach (var id in Cache.Where(p => p.Value.ExpiresAt <= Now).Select(p => p.Key).ToArray()) Remove(id); }
    static void PurgeAll() { foreach (var image in Cache.Values) image.Dispose(); Cache.Clear(); LastFrames.Clear(); CacheBytes = 0; }
}
