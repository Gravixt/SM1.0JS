// src/RedisManager.js - Redis Communication Module

const { createClient } = require('redis');
const EventEmitter = require('events');
const Logger = require('./utils/Logger');

class RedisManager extends EventEmitter {
    constructor(configManager) {
        super();
        this.config = configManager;
        this.logger = new Logger('RedisManager');
        this.client = null;
        this.publisher = null;
        this.subscriber = null;
        this.subscriptions = new Map();
        this.connected = false;
    }

    async connect() {
        if (!this.config.get('redis.enabled')) {
            this.logger.info('Redis is disabled in configuration');
            return false;
        }

        try {
            const redisConfig = {
                socket: {
                    host: this.config.get('redis.host', 'localhost'),
                    port: this.config.get('redis.port', 6379)
                },
                database: this.config.get('redis.db', 0)
            };

            // Create clients
            this.client = createClient(redisConfig);
            this.publisher = this.client.duplicate();
            this.subscriber = this.client.duplicate();

            // Setup error handlers
            this.setupErrorHandlers();

            // Connect all clients
            await Promise.all([
                this.client.connect(),
                this.publisher.connect(),
                this.subscriber.connect()
            ]);

            this.connected = true;
            this.logger.info('Connected to Redis');

            // Setup default subscriptions
            await this.setupDefaultSubscriptions();

            return true;
        } catch (error) {
            this.logger.error(`Failed to connect to Redis: ${error.message}`);
            this.connected = false;
            return false;
        }
    }

    setupErrorHandlers() {
        const handleError = (client, name) => {
            client.on('error', err => {
                this.logger.error(`Redis ${name} error: ${err.message}`);
                this.emit('error', { client: name, error: err });
            });

            client.on('ready', () => {
                this.logger.info(`Redis ${name} ready`);
            });

            client.on('end', () => {
                this.logger.warn(`Redis ${name} disconnected`);
                this.connected = false;
            });
        };

        handleError(this.client, 'client');
        handleError(this.publisher, 'publisher');
        handleError(this.subscriber, 'subscriber');
    }

    async setupDefaultSubscriptions() {
        // Subscribe to responses from Velocity
        await this.subscriber.subscribe('server:status', (message) => {
            try {
                const data = JSON.parse(message);
                this.emit('server:status', data);
                this.logger.debug(`Server status update: ${data.serverId} -> ${data.status}`);
            } catch (error) {
                this.logger.error('Error parsing server status message:', error);
            }
        });
        
        await this.subscriber.subscribe('proxy:status', (message) => {
            try {
                const data = JSON.parse(message);
                this.emit('proxy:status', data);
                
                if (data.action === 'proxy_shutdown') {
                    this.logger.warn('Velocity proxy is shutting down');
                    // Mark all servers as not registered
                    if (this.controller) {
                        this.controller.servers.forEach(server => {
                            server.registeredWithVelocity = false;
                        });
                    }
                }
            } catch (error) {
                this.logger.error('Error parsing proxy status message:', error);
            }
        });
        
        await this.subscriber.subscribe('proxy:heartbeat', (message) => {
            try {
                const data = JSON.parse(message);
                this.emit('proxy:heartbeat', data);
                this.lastProxyHeartbeat = Date.now();
            } catch (error) {
                this.logger.error('Error parsing proxy heartbeat:', error);
            }
        });
        
        await this.subscriber.subscribe('server:request', async (message) => {
            try {
                const data = JSON.parse(message);
                
                if (data.action === 'list_servers' && data.source === 'velocity') {
                    // Velocity is requesting the list of servers
                    await this.sendServerList();
                } else if (data.action === 'start_server') {
                    // Velocity is requesting a new server
                    this.emit('server:request', data);
                }
            } catch (error) {
                this.logger.error('Error handling server request:', error);
            }
        });
    }

    async sendServerList() {
        if (!this.controller) return;
        
        const servers = [];
        
        // Add all running servers
        this.controller.servers.forEach(server => {
            if (server.status === 'ready' && server.port) {
                servers.push({
                    id: server.id,
                    host: '127.0.0.1',
                    port: server.port,
                    type: server.type || 'dynamic',
                    gameType: server.gameType || '',
                    maxPlayers: server.maxPlayers || 20
                });
            }
        });
        
        // Add static servers
        if (this.controller.staticServers) {
            this.controller.staticServers.forEach(server => {
                if (server.status === 'ready' && server.port) {
                    servers.push({
                        id: server.id,
                        host: '127.0.0.1',
                        port: server.port,
                        type: 'static',
                        gameType: '',
                        maxPlayers: server.maxPlayers || 100
                    });
                }
            });
        }
        
        const response = {
            action: 'list_servers',
            servers: servers
        };
        
        await this.publish('server:response', JSON.stringify(response));
        this.logger.info(`Sent server list with ${servers.length} servers to Velocity`);
    }

    async subscribe(pattern, handler) {
        if (!this.connected) {
            this.logger.warn('Cannot subscribe: not connected to Redis');
            return;
        }

        try {
            // Store handler
            if (!this.subscriptions.has(pattern)) {
                this.subscriptions.set(pattern, []);
            }
            this.subscriptions.get(pattern).push(handler);

            // Redis subscription
            if (pattern.includes('*')) {
                // Pattern subscription
                await this.subscriber.pSubscribe(pattern, async (message, channel) => {
                    try {
                        const data = JSON.parse(message);
                        const handlers = this.subscriptions.get(pattern) || [];
                        for (const h of handlers) {
                            await h(data, channel);
                        }
                    } catch (error) {
                        this.logger.error(`Error handling message: ${error.message}`);
                    }
                });
            } else {
                // Regular subscription
                await this.subscriber.subscribe(pattern, async (message) => {
                    try {
                        const data = JSON.parse(message);
                        const handlers = this.subscriptions.get(pattern) || [];
                        for (const h of handlers) {
                            await h(data, pattern);
                        }
                    } catch (error) {
                        this.logger.error(`Error handling message: ${error.message}`);
                    }
                });
            }

            this.logger.debug(`Subscribed to ${pattern}`);
        } catch (error) {
            this.logger.error(`Failed to subscribe to ${pattern}: ${error.message}`);
        }
    }

    async publish(channel, data) {
        if (!this.connected) {
            this.logger.warn('Cannot publish: not connected to Redis');
            return false;
        }

        try {
            const message = typeof data === 'string' ? data : JSON.stringify(data);
            await this.publisher.publish(channel, message);
            this.logger.debug(`Published to ${channel}`);
            return true;
        } catch (error) {
            this.logger.error(`Failed to publish to ${channel}: ${error.message}`);
            return false;
        }
    }

    // Server management methods

    async notifyServerRegistered(server) {
        const data = {
            action: 'register',
            serverId: server.id,
            type: server.type,
            gameType: server.gameType,
            address: '127.0.0.1',
            port: server.port,
            maxPlayers: server.maxPlayers,
            plugins: server.plugins,
            timestamp: Date.now()
        };

        // Only publish to one channel to avoid duplicates
        await this.publish('server:registered', data);
        
        this.logger.info(`Published server registration: ${server.id} on port ${server.port}`);
    }

    async notifyServerUnregistered(serverId) {
        const data = {
            action: 'unregister',
            serverId,
            timestamp: Date.now()
        };

        await this.publish('server:unregistered', data);
        await this.publish('velocity:servers', data);
    }

    async requestServerConfig(serverId, pluginName, requirements) {
        const requestId = `${serverId}:${pluginName}:${Date.now()}`;
        
        const data = {
            requestId,
            serverId,
            pluginName,
            requirements,
            timestamp: Date.now()
        };

        // Setup response listener
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Config request timeout'));
            }, this.config.get('dynamicServers.requestTimeout', 5000));

            const responseChannel = `server:${serverId}:config:response`;
            
            this.subscriber.subscribe(responseChannel, (message) => {
                try {
                    const response = JSON.parse(message);
                    if (response.requestId === requestId) {
                        clearTimeout(timeout);
                        this.subscriber.unsubscribe(responseChannel);
                        resolve(response.config);
                    }
                } catch (error) {
                    reject(error);
                }
            });

            // Send request
            this.publish(`server:${serverId}:config:request`, data);
        });
    }

    async sendConfigToServer(serverId, config) {
        const data = {
            serverId,
            config,
            timestamp: Date.now()
        };

        await this.publish(`server:${serverId}:config`, data);
    }

    // Player tracking methods

    async trackPlayerJoin(player, serverId) {
        const data = {
            player,
            server: serverId,
            timestamp: Date.now()
        };

        await this.publish('player:join', data);
        
        // Store in Redis for persistence
        if (this.client) {
            const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}player:${player}`;
            await this.client.hSet(key, {
                server: serverId,
                joinTime: Date.now().toString()
            });
        }
    }

    async trackPlayerQuit(player, serverId) {
        const data = {
            player,
            server: serverId,
            timestamp: Date.now()
        };

        await this.publish('player:quit', data);
        
        // Remove from Redis
        if (this.client) {
            const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}player:${player}`;
            await this.client.del(key);
        }
    }

    async trackPlayerSwitch(player, fromServer, toServer) {
        const data = {
            player,
            from: fromServer,
            to: toServer,
            timestamp: Date.now()
        };

        await this.publish('player:switch', data);
        
        // Update in Redis
        if (this.client) {
            const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}player:${player}`;
            await this.client.hSet(key, {
                server: toServer,
                lastSwitch: Date.now().toString()
            });
        }
    }

    async getPlayerLocation(player) {
        if (!this.client) return null;
        
        const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}player:${player}`;
        const data = await this.client.hGetAll(key);
        
        return data.server || null;
    }

    async getAllPlayers() {
        if (!this.client) return [];
        
        const prefix = `${this.config.get('redis.keyPrefix', 'mcserver:')}player:*`;
        const keys = await this.client.keys(prefix);
        
        const players = [];
        for (const key of keys) {
            const player = key.split(':').pop();
            const data = await this.client.hGetAll(key);
            players.push({
                name: player,
                server: data.server,
                joinTime: parseInt(data.joinTime)
            });
        }
        
        return players;
    }

    // Server state methods

    async storeServerState(serverId, state) {
        if (!this.client) return;
        
        const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}server:${serverId}`;
        await this.client.hSet(key, {
            ...state,
            lastUpdate: Date.now().toString()
        });
        
        // Set expiry for dynamic servers
        if (state.type === 'dynamic') {
            await this.client.expire(key, 3600); // 1 hour
        }
    }

    async getServerState(serverId) {
        if (!this.client) return null;
        
        const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}server:${serverId}`;
        return await this.client.hGetAll(key);
    }

    async removeServerState(serverId) {
        if (!this.client) return;
        
        const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}server:${serverId}`;
        await this.client.del(key);
    }

    // Game queue methods

    async addToGameQueue(player, gameType) {
        if (!this.client) return false;
        
        const queueKey = `${this.config.get('redis.keyPrefix', 'mcserver:')}queue:${gameType}`;
        const playerData = JSON.stringify({
            player,
            timestamp: Date.now()
        });
        
        await this.client.rPush(queueKey, playerData);
        
        // Notify about queue update
        await this.publish('queue:update', {
            gameType,
            action: 'join',
            player
        });
        
        return true;
    }

    async removeFromGameQueue(player, gameType) {
        if (!this.client) return false;
        
        const queueKey = `${this.config.get('redis.keyPrefix', 'mcserver:')}queue:${gameType}`;
        const queue = await this.client.lRange(queueKey, 0, -1);
        
        for (const item of queue) {
            const data = JSON.parse(item);
            if (data.player === player) {
                await this.client.lRem(queueKey, 1, item);
                
                // Notify about queue update
                await this.publish('queue:update', {
                    gameType,
                    action: 'leave',
                    player
                });
                
                return true;
            }
        }
        
        return false;
    }

    async getGameQueue(gameType) {
        if (!this.client) return [];
        
        const queueKey = `${this.config.get('redis.keyPrefix', 'mcserver:')}queue:${gameType}`;
        const queue = await this.client.lRange(queueKey, 0, -1);
        
        return queue.map(item => JSON.parse(item));
    }

    // Metrics methods

    async recordMetric(metric, value) {
        if (!this.client) return;
        
        const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}metrics:${metric}`;
        const timestamp = Date.now();
        
        await this.client.zAdd(key, {
            score: timestamp,
            value: JSON.stringify({ value, timestamp })
        });
        
        // Keep only last hour of metrics
        const hourAgo = timestamp - 3600000;
        await this.client.zRemRangeByScore(key, '-inf', hourAgo);
    }

    async getMetrics(metric, duration = 3600000) {
        if (!this.client) return [];
        
        const key = `${this.config.get('redis.keyPrefix', 'mcserver:')}metrics:${metric}`;
        const now = Date.now();
        const since = now - duration;
        
        const data = await this.client.zRangeByScore(key, since, now);
        
        return data.map(item => JSON.parse(item));
    }

    // Cleanup methods

    async cleanup() {
        this.logger.info('Cleaning up Redis connections...');
        
        if (this.subscriber) {
            await this.subscriber.quit();
        }
        
        if (this.publisher) {
            await this.publisher.quit();
        }
        
        if (this.client) {
            await this.client.quit();
        }
        
        this.connected = false;
        this.logger.info('Redis connections closed');
    }

    async disconnect() {
        await this.cleanup();
    }
}

module.exports = RedisManager;