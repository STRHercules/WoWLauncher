#include "../src/ClientAddress.h"
#include <cassert>

int main()
{
    assert(LauncherClientAddress("127.0.0.1", "127.0.0.1", "203.0.113.1") == "203.0.113.1");
    assert(LauncherClientAddress("127.0.0.1", "127.0.0.1", "203.0.113.2") == "203.0.113.2");
    assert(LauncherClientAddress("203.0.113.9", "127.0.0.1", "203.0.113.1") == "203.0.113.9");
    assert(LauncherClientAddress("127.0.0.1", "", "203.0.113.1") == "127.0.0.1");
    assert(LauncherClientAddress("127.0.0.1", "127.0.0.1", "") == "127.0.0.1");
    assert(LauncherClientAddress("::1", "::1", "2001:db8::1") == "2001:db8::1");
    assert(LauncherClientAddress("127.0.0.1", "127.0.0.1", "1.2.3.4, 5.6.7.8") == "127.0.0.1");
    assert(LauncherClientAddress("127.0.0.1", "127.0.0.1", std::string(46, '1')) == "127.0.0.1");
    assert(LauncherClientAddress("127.0.0.1", "127.0.0.1", "spoofed") == "127.0.0.1");
}
