# Server Manager Source Code

The modular server manager consists of:

- **ServerManager.js** - Main entry point and orchestrator
- **ConfigManager.js** - Configuration management
- **ServerController.js** - Server lifecycle management
- **RedisManager.js** - Redis communication
- **PoolManager.js** - Warm server pool management
- **NetworkManager.js** - Port and network management
- **PluginBridge.js** - Plugin communication bridge
- **utils/Logger.js** - Centralized logging

## API Server

The API server (api/ApiServer.js) provides:
- REST endpoints for server management
- WebSocket support for real-time updates
- Dashboard serving
- Metrics and monitoring endpoints