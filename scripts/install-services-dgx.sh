#!/bin/bash
# Noesis Ship - DGX Service Installation Script
#
# This script installs systemd service files for Noesis Ship on DGX (Ubuntu Linux).
# Run with sudo.

set -e

echo "=== Noesis Ship DGX Service Installer ==="
echo ""

# Check if running as root
if [ "$EUID" -ne 0 ]; then
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Get the actual user who invoked sudo
ACTUAL_USER=${SUDO_USER:-$USER}
INSTALL_DIR="/home/$ACTUAL_USER/projects/noesis-ship"

echo "Installation Configuration:"
echo "  User: $ACTUAL_USER"
echo "  Install Directory: $INSTALL_DIR"
echo ""

# Check if installation directory exists
if [ ! -d "$INSTALL_DIR" ]; then
    echo "Error: Installation directory does not exist: $INSTALL_DIR"
    echo "Please clone the repository first."
    exit 1
fi

# Check if config directory exists
if [ ! -d "$INSTALL_DIR/config/systemd" ]; then
    echo "Error: Systemd config directory not found: $INSTALL_DIR/config/systemd"
    exit 1
fi

echo "Step 1: Creating required directories..."
mkdir -p "$INSTALL_DIR/data/jetstream"
mkdir -p "$INSTALL_DIR/logs"
chown -R $ACTUAL_USER:$ACTUAL_USER "$INSTALL_DIR/data" "$INSTALL_DIR/logs"
echo "✓ Directories created"
echo ""

echo "Step 2: Installing systemd service files (templating paths for $ACTUAL_USER)..."
ACTUAL_HOME=$(eval echo "~$ACTUAL_USER")
for svc in nats-server.service noesis-ship-websocket.service noesis-ship-agent-daemon.service; do
    sed -e "s|__USER__|$ACTUAL_USER|g" -e "s|__HOME__|$ACTUAL_HOME|g" \
        "$INSTALL_DIR/config/systemd/$svc" > "/etc/systemd/system/$svc"
done
echo "✓ Service files installed to /etc/systemd/system/ (paths set for $ACTUAL_USER)"
echo ""

echo "Step 3: Templating NATS config..."
sed -e "s|__HOME__|$ACTUAL_HOME|g" \
    "$INSTALL_DIR/config/nats-server.conf" > "$INSTALL_DIR/config/nats-server.local.conf"
chown $ACTUAL_USER:$ACTUAL_USER "$INSTALL_DIR/config/nats-server.local.conf"
echo "✓ NATS config written to config/nats-server.local.conf"
echo ""

echo "Step 4: Reloading systemd configuration..."
systemctl daemon-reload
echo "✓ Systemd reloaded"
echo ""

echo "Step 5: Enabling services to start on boot..."
systemctl enable nats-server
systemctl enable noesis-ship-websocket
systemctl enable noesis-ship-agent-daemon
echo "✓ Services enabled"
echo ""

echo "=== Installation Complete ==="
echo ""
echo "Next steps:"
echo ""
echo "1. Configure environment variables:"
echo "   cd $INSTALL_DIR/adapters/websocket"
echo "   cp .env.example .env"
echo "   # Edit .env with your settings"
echo ""
echo "2. Start services:"
echo "   sudo systemctl start nats-server"
echo "   sudo systemctl start noesis-ship-websocket"
echo "   sudo systemctl start noesis-ship-agent-daemon"
echo ""
echo "3. Check service status:"
echo "   sudo systemctl status nats-server noesis-ship-websocket noesis-ship-agent-daemon"
echo ""
echo "4. View logs:"
echo "   sudo journalctl -u 'noesis-ship*' -u nats-server -f"
echo ""
echo "5. Run health check:"
echo "   $INSTALL_DIR/scripts/health-check.sh"
echo ""
echo "For detailed documentation, see:"
echo "  $INSTALL_DIR/docs/deployment/dgx.md"
echo ""
