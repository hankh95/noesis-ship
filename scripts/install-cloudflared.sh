#!/usr/bin/env bash
set -euo pipefail

# Noesis Ship — Cloudflare Tunnel Installer
#
# Sets up cloudflared to expose your local noesis-ship WebSocket relay
# at wss://ship.congruentsys.com (or your chosen subdomain).
#
# Usage:
#   ./scripts/install-cloudflared.sh [tunnel-name]
#
# Prerequisites:
#   - A Cloudflare account with a domain configured
#   - DNS for the domain managed by Cloudflare
#   - Run `cloudflared tunnel login` first to authenticate

TUNNEL_NAME="${1:-noesis-ship}"
HOSTNAME="${CLOUDFLARED_HOSTNAME:-ship.congruentsys.com}"
WS_PORT="${WS_PORT:-3100}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG_TEMPLATE="$SCRIPT_DIR/../config/cloudflared/config.yml"

echo "=== Noesis Ship — Cloudflare Tunnel Setup ==="
echo ""

# 1. Check cloudflared is installed
if ! command -v cloudflared &>/dev/null; then
    echo "Installing cloudflared..."
    if [[ "$(uname)" == "Darwin" ]]; then
        brew install cloudflared
    elif command -v apt-get &>/dev/null; then
        curl -L --output /tmp/cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
        sudo dpkg -i /tmp/cloudflared.deb
        rm /tmp/cloudflared.deb
    else
        echo "ERROR: Unsupported OS. Install cloudflared manually:"
        echo "  https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        exit 1
    fi
fi

echo "cloudflared version: $(cloudflared --version)"

# 2. Check authentication
if [ ! -f "$HOME/.cloudflared/cert.pem" ]; then
    echo ""
    echo "You need to authenticate cloudflared first."
    echo "This will open a browser window to log in to Cloudflare."
    echo ""
    cloudflared tunnel login
fi

# 3. Create tunnel
echo ""
echo "Creating tunnel '$TUNNEL_NAME'..."
TUNNEL_OUTPUT=$(cloudflared tunnel create "$TUNNEL_NAME" 2>&1) || {
    if echo "$TUNNEL_OUTPUT" | grep -q "already exists"; then
        echo "Tunnel '$TUNNEL_NAME' already exists — using existing tunnel."
        TUNNEL_OUTPUT=$(cloudflared tunnel info "$TUNNEL_NAME" 2>&1)
    else
        echo "ERROR: $TUNNEL_OUTPUT"
        exit 1
    fi
}

# Extract tunnel ID
TUNNEL_ID=$(cloudflared tunnel list --output json 2>/dev/null | python3 -c "
import json, sys
tunnels = json.load(sys.stdin)
for t in tunnels:
    if t['name'] == '$TUNNEL_NAME':
        print(t['id'])
        break
" 2>/dev/null || echo "")

if [ -z "$TUNNEL_ID" ]; then
    echo "ERROR: Could not determine tunnel ID. Run 'cloudflared tunnel list' to check."
    exit 1
fi

echo "Tunnel ID: $TUNNEL_ID"

# 4. Route DNS
echo ""
echo "Routing $HOSTNAME -> tunnel '$TUNNEL_NAME'..."
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME" 2>&1 || {
    echo "(DNS route may already exist — that's fine)"
}

# 5. Write config
CONFIG_DIR="$HOME/.cloudflared"
CONFIG_FILE="$CONFIG_DIR/config.yml"

echo ""
echo "Writing config to $CONFIG_FILE..."

if [ -f "$CONFIG_TEMPLATE" ]; then
    sed \
        -e "s|__TUNNEL_ID__|$TUNNEL_ID|g" \
        -e "s|__HOME__|$HOME|g" \
        "$CONFIG_TEMPLATE" > "$CONFIG_FILE"
    # Update port if non-default
    if [ "$WS_PORT" != "3100" ]; then
        sed -i.bak "s|localhost:3100|localhost:$WS_PORT|g" "$CONFIG_FILE"
        rm -f "$CONFIG_FILE.bak"
    fi
else
    cat > "$CONFIG_FILE" <<EOF
tunnel: $TUNNEL_ID
credentials-file: $CONFIG_DIR/$TUNNEL_ID.json

ingress:
  - hostname: $HOSTNAME
    service: http://localhost:$WS_PORT
    originRequest:
      noTLSVerify: true
  - service: http_status:404
EOF
fi

echo "Config written."

# 6. Install as service
echo ""
echo "Installing cloudflared as a service..."

if [[ "$(uname)" == "Darwin" ]]; then
    cloudflared service install 2>&1 || echo "(Service may already be installed)"
    echo ""
    echo "macOS: cloudflared runs via launchd."
    echo "  Check: launchctl list | grep cloudflared"
    echo "  Logs:  log show --predicate 'process == \"cloudflared\"' --last 5m"
else
    # Linux — install as user service if not root
    if [ "$(id -u)" -ne 0 ]; then
        mkdir -p "$HOME/.config/systemd/user"
        cat > "$HOME/.config/systemd/user/cloudflared.service" <<EOF
[Unit]
Description=Cloudflare Tunnel (Noesis Ship)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$(command -v cloudflared) tunnel --config $CONFIG_FILE run $TUNNEL_NAME
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
        systemctl --user daemon-reload
        systemctl --user enable cloudflared
        systemctl --user start cloudflared
        echo ""
        echo "Linux: cloudflared installed as user service."
        echo "  Status: systemctl --user status cloudflared"
        echo "  Logs:   journalctl --user -u cloudflared -f"
    else
        cloudflared service install 2>&1 || echo "(Service may already be installed)"
        echo ""
        echo "Linux: cloudflared installed as system service."
        echo "  Status: systemctl status cloudflared"
        echo "  Logs:   journalctl -u cloudflared -f"
    fi
fi

# 7. Update noesis-ship .env
ENV_FILE="$SCRIPT_DIR/../packages/relay/.env"
if [ -f "$ENV_FILE" ]; then
    if ! grep -q "^RELAY_URL=" "$ENV_FILE"; then
        echo "" >> "$ENV_FILE"
        echo "# Cloudflare Tunnel relay URL (FEAT-016)" >> "$ENV_FILE"
        echo "RELAY_URL=wss://$HOSTNAME" >> "$ENV_FILE"
        echo ""
        echo "Added RELAY_URL=wss://$HOSTNAME to .env"
    else
        echo ""
        echo "RELAY_URL already set in .env"
    fi
fi

echo ""
echo "=== Setup Complete ==="
echo ""
echo "  Tunnel:  $TUNNEL_NAME ($TUNNEL_ID)"
echo "  URL:     wss://$HOSTNAME"
echo "  Config:  $CONFIG_FILE"
echo ""
echo "Ships Comm will auto-discover this relay URL on next connect."
echo "No app configuration needed — it just works."
echo ""
echo "Test: cloudflared tunnel run $TUNNEL_NAME"
