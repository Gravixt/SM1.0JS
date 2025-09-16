// src/PluginBridge.js - Plugin Communication Interface

const EventEmitter = require('events');
const Logger = require('./utils/Logger');

class PluginBridge extends EventEmitter {
    constructor(serverController, redisManager) {
        super();
        this.controller = serverController;
        this.redis = redisManager;
        this.logger = new Logger('PluginBridge');
        this.configRequests = new Map();
        this.pendingConfigs = new Map();
    }

    async initialize() {
        if (!this.redis || !this.redis.connected) {
            this.logger.warn('Redis not available, plugin bridge limited');
            return;
        }

        // Listen for config requests from plugins
        this.redis.on('configRequest', async (data) => {
            await this.handleConfigRequest(data);
        });

        // Listen for server ready notifications from plugins
        this.redis.subscribe('server:ready', async (data) => {
            await this.handleServerReady(data);
        });

        // Listen for game state updates
        this.redis.subscribe('game:state:*', async (data, channel) => {
            const gameType = channel.split(':')[2];
            await this.handleGameStateUpdate(gameType, data);
        });

        this.logger.info('Plugin bridge initialized');
    }

    async handleConfigRequest(data) {
        const { serverId, pluginName, requirements } = data;
        
        this.logger.info(`Config request from ${pluginName} for server ${serverId}`);
        
        // Check if this is our server
        const server = this.controller.getServer(serverId);
        if (!server) {
            this.logger.warn(`Server ${serverId} not found`);
            return;
        }

        // Generate config based on requirements
        const config = await this.generatePluginConfig(server, pluginName, requirements);
        
        // Send config back to plugin
        await this.sendConfigToPlugin(serverId, pluginName, config);
        
        // Store for tracking
        this.configRequests.set(`${serverId}:${pluginName}`, {
            requirements,
            config,
            timestamp: Date.now()
        });
    }

    async generatePluginConfig(server, pluginName, requirements) {
        const config = {
            serverId: server.id,
            serverType: server.type,
            gameType: server.gameType,
            port: server.port,
            maxPlayers: server.maxPlayers
        };

        // World configuration
        if (requirements.worldType) {
            config.world = this.generateWorldConfig(requirements.worldType);
        }

        // Game configuration
        if (requirements.gameConfig) {
            config.game = await this.generateGameConfig(
                server.gameType, 
                requirements.gameConfig
            );
        }

        // Database configuration
        if (requirements.database) {
            config.database = this.getDatabaseConfig(pluginName);
        }

        // Redis configuration
        if (requirements.redis) {
            config.redis = {
                host: this.redis.config.get('redis.host'),
                port: this.redis.config.get('redis.port'),
                keyPrefix: `${server.id}:${pluginName}:`
            };
        }

        // Custom settings
        if (requirements.settings) {
            config.settings = requirements.settings;
        }

        return config;
    }

    generateWorldConfig(worldType) {
        const configs = {
            void: {
                type: 'FLAT',
                generator: 'VoidGenerator',
                settings: '2;0;1;minecraft:air',
                structures: false,
                spawn: { x: 0, y: 64, z: 0 },
                worldBorder: 100
            },
            flat: {
                type: 'FLAT',
                generator: 'default',
                settings: '',
                structures: false,
                spawn: { x: 0, y: 64, z: 0 },
                worldBorder: 500
            },
            normal: {
                type: 'DEFAULT',
                generator: 'default',
                settings: '',
                structures: true,
                spawn: 'auto',
                worldBorder: 1000
            },
            skyblock: {
                type: 'FLAT',
                generator: 'VoidGenerator',
                settings: '2;0;1;minecraft:air',
                structures: false,
                spawn: { x: 0, y: 100, z: 0 },
                worldBorder: 200,
                islands: true
            }
        };

        return configs[worldType] || configs.void;
    }

    async generateGameConfig(gameType, requirements) {
        const template = this.controller.config.getGameTemplate(gameType);
        
        if (!template || !template.gameConfig) {
            return requirements;
        }

        // Merge template config with requirements
        return {
            ...template.gameConfig,
            ...requirements
        };
    }

    getDatabaseConfig(pluginName) {
        // TODO: Implement database configuration
        return {
            type: 'sqlite',
            path: `./data/${pluginName}.db`
        };
    }

    async sendConfigToPlugin(serverId, pluginName, config) {
        const channel = `server:${serverId}:plugin:${pluginName}:config`;
        
        await this.redis.publish(channel, {
            serverId,
            pluginName,
            config,
            timestamp: Date.now()
        });
        
        this.logger.debug(`Sent config to ${pluginName} on ${serverId}`);
    }

    async notifyServerReady(server) {
        if (!this.redis || !this.redis.connected) return;
        
        await this.redis.publish('server:available', {
            serverId: server.id,
            type: server.type,
            gameType: server.gameType,
            port: server.port,
            maxPlayers: server.maxPlayers,
            plugins: server.plugins,
            timestamp: Date.now()
        });
        
        // Register with velocity/bungeecord
        await this.redis.notifyServerRegistered(server);
    }

    async handleServerReady(data) {
        const { serverId, pluginName } = data;
        
        this.logger.info(`Server ${serverId} ready (reported by ${pluginName})`);
        
        const server = this.controller.getServer(serverId);
        if (server) {
            server.status = 'ready';
            server.pluginReady = true;
            this.emit('serverPluginReady', server);
        }
    }

    async handleGameStateUpdate(gameType, data) {
        const { serverId, state, players, metadata } = data;
        
        const server = this.controller.getServer(serverId);
        if (!server) return;
        
        // Update server metadata
        server.gameState = state;
        server.gameMetadata = metadata;
        
        // Handle state-specific actions
        switch (state) {
            case 'waiting':
                // Server is waiting for players
                if (players < server.minPlayers) {
                    await this.requestMorePlayers(server);
                }
                break;
                
            case 'starting':
                // Game is starting
                await this.notifyGameStarting(server);
                break;
                
            case 'ingame':
                // Game is in progress
                server.inGame = true;
                break;
                
            case 'ending':
                // Game is ending
                await this.prepareServerForReset(server);
                break;
                
            case 'resetting':
                // Server is resetting
                server.inGame = false;
                await this.notifyServerAvailable(server);
                break;
        }
        
        this.emit('gameStateUpdate', {
            serverId,
            gameType,
            state,
            metadata
        });
    }

    async requestMorePlayers(server) {
        // Notify matchmaking system
        await this.redis.publish('matchmaking:request', {
            serverId: server.id,
            gameType: server.gameType,
            playersNeeded: server.minPlayers - server.players.length,
            currentPlayers: server.players.length,
            maxPlayers: server.maxPlayers
        });
    }

    async notifyGameStarting(server) {
        await this.redis.publish('game:starting', {
            serverId: server.id,
            gameType: server.gameType,
            players: server.players,
            timestamp: Date.now()
        });
    }

    async prepareServerForReset(server) {
        // Schedule server for recycling
        setTimeout(async () => {
            if (server.players.length === 0) {
                await this.controller.emit('serverReadyForRecycle', server.id);
            }
        }, 10000); // Wait 10 seconds after game ends
    }

    async notifyServerAvailable(server) {
        await this.redis.publish('server:available', {
            serverId: server.id,
            gameType: server.gameType,
            ready: true
        });
    }

    async requestServerShutdown(serverId, reason) {
        const server = this.controller.getServer(serverId);
        if (!server) return;

        // Notify plugins of impending shutdown
        await this.redis.publish(`server:${serverId}:shutdown`, {
            reason,
            grace: 30000 // 30 second grace period
        });

        // Schedule actual shutdown
        setTimeout(async () => {
            await this.controller.stopDynamicServer(serverId);
        }, 30000);
    }

    getStatus() {
        return {
            configRequests: this.configRequests.size,
            pendingConfigs: this.pendingConfigs.size,
            connected: this.redis && this.redis.connected
        };
    }
}

module.exports = PluginBridge;