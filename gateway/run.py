"""One application/store, two strictly separate loopback listeners."""

import argparse
import socket
import uvicorn
from gateway.settings import settings


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=settings.public_port)
    args = parser.parse_args()
    if not settings.accounts_worker_url or not settings.accounts_worker_secret:
        parser.error("Configure ACCOUNTS_WORKER_URL and ACCOUNTS_WORKER_SECRET")
    if args.port != settings.public_port:
        parser.error("Public listener must remain 18900; local listener is 18901")
    sockets = []
    try:
        for port in [settings.public_port, settings.local_port]:
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            sock.bind((settings.bind_host, port))
            sock.listen(128)
            sockets.append(sock)
        uvicorn.Server(
            uvicorn.Config(
                "gateway.app:app",
                proxy_headers=False,
                access_log=False,
                ws_max_size=1048576,
                limit_concurrency=64,
            )
        ).run(sockets=sockets)
    finally:
        for sock in sockets:
            sock.close()


if __name__ == "__main__":
    main()
