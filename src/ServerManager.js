// src/ServerManager.js - Optimized with hub server support
const ConfigManager = require('./ConfigManager');
const ServerController = require('./ServerController');
const RedisManager = require('./RedisManager');
const PoolManager = require('./PoolManager');
const ApiServer = require('../api/ApiServer');
const Logger = require('./utils/Logger');

class ServerManager {
    constructor() {
        this.logger = new Logger('ServerManager');
        this.configManager = new ConfigManager();
        this.redisManager = new RedisManager(this.configManager);
        this.serverController = new ServerController(this.configManager, this.redisManager);
        this.poolManager = new PoolManager(this.serverController, this.configManager);
        this.apiServer = new ApiServer(this);
    }

    async start() {
        try {
            this.logger.info('Starting Server Manager...');
            
            // Load configuration
            await this.configManager.load();
            
            // Connect to Redis
            await this.redisManager.connect();
            
            // Initialize server controller (without auto-starting anything)
            await this.serverController.initialize();
            
            // STEP 1: Start Velocity proxy FIRST
            const proxyConfig = this.configManager.get('proxy');
            if (proxyConfig && proxyConfig.enabled) {
                this.logger.info('Starting Velocity proxy...');
                await this.serverController.startProxy();
                
                // Wait for Velocity to be fully ready
                await new Promise(resolve => setTimeout(resolve, 2000));
                this.logger.info('Velocity proxy ready');
            }
            
            // STEP 2: Start hub server (if configured)
            const hubConfig = this.configManager.get('servers.hub');
            if (hubConfig && hubConfig.enabled !== false) {
                try {
                    this.logger.info('Starting hub server...');
                    await this.serverController.startStaticServer('hub');
                    // Wait for hub to be ready
                    await new Promise(resolve => setTimeout(resolve, 3000));
                } catch (error) {
                    this.logger.error(`Failed to start hub server: ${error.message}`);
                    // Continue anyway - dynamic servers can still work
                }
            }
            
            // STEP 3: Start other static servers
            const staticServers = this.configManager.get('servers.static', []);
            for (const serverConfig of staticServers) {
                // Skip if disabled
                if (serverConfig.enabled === false) continue;
                
                try {
                    this.logger.info(`Starting static server: ${serverConfig.id}`);
                    await this.serverController.startStaticServer(serverConfig.id);
                } catch (error) {
                    this.logger.error(`Failed to start static server ${serverConfig.id}: ${error.message}`);
                }
            }
            
            // STEP 4: Start pool manager for dynamic servers
            await this.poolManager.start();
            
            // STEP 5: Start API server
            await this.apiServer.start();
            
            // Setup shutdown handlers
            this.setupShutdownHandlers();
            
            this.logger.info('Server Manager started successfully');
            const apiPort = this.configManager.get('ports.apiPort', 3000);
            this.logger.info(`Dashboard available at: http://localhost:${apiPort}`);
            
            if (proxyConfig && proxyConfig.enabled) {
                const proxyHost = proxyConfig.host || 'localhost';
                const proxyPort = proxyConfig.port || 25565;
                this.logger.info(`Players can connect to: ${proxyHost}:${proxyPort}`);
            }
        } catch (error) {
            this.logger.error(`Failed to start Server Manager: ${error.message}`);
            throw error;
        }
    }

    setupShutdownHandlers() {
        const shutdown = async (signal) => {
            this.logger.info(`Received ${signal}, shutting down gracefully...`);
            
            try {
                // Stop API server
                await this.apiServer.stop();
                
                // Stop pool manager
                await this.poolManager.stop();
                
                // Stop all backend servers first
                await this.serverController.stopAll();
                
                // Stop Velocity proxy last
                await this.serverController.stopProxy();
                
                // Disconnect from Redis
                await this.redisManager.disconnect();
                
                this.logger.info('Shutdown complete');
                process.exit(0);
            } catch (error) {
                this.logger.error(`Error during shutdown: ${error.message}`);
                process.exit(1);
            }
        };
        
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        
        // Handle uncaught exceptions
        process.on('uncaughtException', (error) => {
            this.logger.error(`Uncaught exception: ${error.message}`, error.stack);
            shutdown('uncaughtException');
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            this.logger.error(`Unhandled rejection at: ${promise}, reason: ${reason}`);
        });
    }

    // Getter methods for compatibility
    get config() { return this.configManager; }
    get redis() { return this.redisManager; }
    get controller() { return this.serverController; }
    get pool() { return this.poolManager; }
    get api() { return this.apiServer; }
}

// Auto-start if run directly
if (require.main === module) {
    const manager = new ServerManager();
    manager.start().catch(err => {
        console.error('Failed to start:', err);
        process.exit(1);
    });
}

module.exports = ServerManager;