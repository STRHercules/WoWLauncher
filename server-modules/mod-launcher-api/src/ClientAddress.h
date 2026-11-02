#pragma once

#include <algorithm>
#include <string>

// Only the configured transport peer can supply a client address for rate limits.
inline std::string LauncherClientAddress(std::string const& peer, std::string const& trustedProxy,
    std::string const& forwarded)
{
    if (trustedProxy.empty() || peer != trustedProxy || forwarded.empty() || forwarded.size() > 45)
        return peer;
    bool valid = std::all_of(forwarded.begin(), forwarded.end(), [](char c)
    {
        return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F') || c == ':' || c == '.';
    });
    return valid ? forwarded : peer;
}
