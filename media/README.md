# NextVision — RTSP relay

This is a **cloud-side relay**, not a way to bypass NAT. It is intentionally isolated from the existing Express service.

## Prerequisite: private path to the camera

The camera's RTSP stream works in the LAN; a cloud host cannot reach its private address without routing. Configure **WireGuard on a compatible store router** to an always-on Linux media host (or authorized manufacturer P2P integration). The router must route the camera LAN to the media host through the tunnel. No PC/gateway is required in the store if the router itself supports this.

Do **not** forward camera RTSP port 554 to the public Internet. Do not commit RTSP user/pass, keys, or private network details.

## Run on a Linux media host (not the Render free web service)

1. Install Docker + Docker Compose. Set up the private VPN and confirm the cloud host can reach the camera RTSP host/port over the tunnel. Use a site-specific, non-overlapping LAN subnet and limit firewall access to only the camera RTSP port.
2. `cd media && cp .env.example .env` and edit `.env` with the actual VLC-tested RTSP URL, using its address reachable over the VPN.
3. `docker compose up -d`
4. `docker compose logs -f mediamtx` and on the same Linux host check `curl -I http://127.0.0.1:8888/camera/index.m3u8` while the camera is online. MediaMTX starts pulling when requested.
5. Add authenticated access through the application API / authorization proxy before exposing HLS to any customer. Local loopback ports are intentionally not public.

HLS playback requires compatible codecs, ordinarily H.264 for browser support. Camera source must be confirmed with VLC/ffprobe first.

## Alternative routes

- Manufacturer P2P SDK *only if* licensed and confirmed compatible with this camera/firmware and Linux.
- **Router VPN**: preferred when the camera has RTSP but no native push.
- A router capable of running FFmpeg/GStreamer can push RTSP outward, but this is unlikely on consumer routers, so verify model and resources first.
- Direct public port forwarding is deliberately excluded (unprotected surveillance feeds).

## Not completed

No remote LAN connection, VPN, video capture, playback authentication, storage, or production customer streaming is asserted by adding this configuration. This only prepares a secure RTSP relay once private connectivity exists.
