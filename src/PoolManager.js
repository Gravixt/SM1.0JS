// src/PoolManager.js - Dynamic Pool Management with Fixes

const EventEmitter = require('events');
const Logger = require('./utils/Logger');

class PoolManager extends EventEmitter {
    constructor(serverController, configManager) {
        super();
        this.controller = serverController;
        this.config = configManager;
        this.logger = new Logger('PoolManager');
        
        this.warmPool = new Set();
        this.reservedServers = new Map();
        this.metrics = {
            totalRequests: 0,
            fulfilledRequests: 0,
            poolHits: 0,
            poolMisses: 0,
            averageWaitTime: 0
        };
        
        this.checkInterval = null;
        this.isRunning = false;
        
        // FIXED: Initialize missing properties
        this.enabled = false;  // Will be set by start()
        this.scaling = false;  // Track if currently scaling
        this.usedPorts = new Set();  // Track used ports
    }

    async start() {
        if (this.isRunning) {
            this.logger.warn('Pool manager already running');
            return;
        }

        // FIXED: Set enabled based on config
        this.enabled = this.config.get('pool.enabled', true);

        if (!this.enabled) {
            this.logger.info('Pool management is disabled');
            return;
        }

        this.isRunning = true;
        this.logger.info('Starting pool manager');

        // FIXED: Setup event listeners
        this.setupEventListeners();

        // Initial pool creation
        await this.scaleToMin();

        // Start monitoring
        const interval = this.config.get('pool.checkInterval', 30000);
        this.checkInterval = setInterval(() => {
            this.checkPoolHealth();
        }, interval);

        this.logger.info('Pool manager started');
    }

    async stop() {
        if (!this.isRunning) return;

        this.isRunning = false;
        this.logger.info('Stopping pool manager');

        // Stop monitoring
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }

        // Shutdown all pool servers
        const servers = Array.from(this.warmPool);
        for (const serverId of servers) {
            await this.removeServerFromPool(serverId);
        }

        this.logger.info('Pool manager stopped');
    }

    // FIXED: Added missing method
    getWarmServers() {
        const warmServers = [];
        for (const serverId of this.warmPool) {
            const server = this.controller.getServer(serverId);
            if (server && server.status === 'ready') {
                warmServers.push(server);
            }
        }
        return warmServers;
    }

    // FIXED: Updated to emit pool updates
    setupEventListeners() {
        // Listen for server requests
        this.controller.on('serverRequested', async (request) => {
            await this.handleServerRequest(request);
            this.emit('poolUpdate', this.getStatus());
        });

        // Listen for server releases
        this.controller.on('serverReleased', async (serverId) => {
            await this.handleServerRelease(serverId);
            this.emit('poolUpdate', this.getStatus());
        });

        // Listen for server crashes
        this.controller.on('serverCrash', async ({ serverId }) => {
            await this.handleServerCrash(serverId);
            this.emit('poolUpdate', this.getStatus());
        });

        // FIXED: Listen for server state changes
        this.controller.on('serverStarted', (serverId) => {
            const server = this.controller.getServer(serverId);
            if (server && this.warmPool.has(serverId)) {
                this.emit('poolUpdate', this.getStatus());
            }
        });

        this.controller.on('serverStopped', (serverId) => {
            if (this.warmPool.has(serverId)) {
                this.warmPool.delete(serverId);
                this.emit('poolUpdate', this.getStatus());
            }
        });

        // Listen for manual server starts that might affect pool
        this.controller.on('serverStateChange', (serverId, state) => {
            this.logger.debug(`Server ${serverId} state changed to ${state}`);
            this.emit('poolUpdate', this.getStatus());
        });
    }

    startMonitoring() {
        const interval = this.config.get('pool.checkInterval', 30000);
        
        this.checkInterval = setInterval(async () => {
            await this.checkPoolHealth();
        }, interval);
    }

    // Check pool health periodically
    async checkPoolHealth() {
        try {
            const current = this.warmPool.size;
            const min = this.config.get('pool.minServers', 2);
            const max = this.config.get('pool.maxServers', 10);
            
            this.logger.debug(`Pool health: ${current} servers (min: ${min}, max: ${max})`);
            
            // Remove unhealthy servers
            for (const serverId of this.warmPool) {
                const server = this.controller.getServer(serverId);
                if (!server || server.status === 'crashed') {
                    this.logger.warn(`Removing unhealthy server ${serverId} from pool`);
                    await this.removeServerFromPool(serverId);
                }
            }
            
            // Scale based on current size
            if (current < min) {
                await this.scaleToMin();
            } else if (current > max) {
                await this.scaleDown();
            }
            
            // Emit update after health check
            this.emit('poolUpdate', this.getStatus());
            
        } catch (error) {
            this.logger.error(`Pool health check failed: ${error.message}`);
        }
    }

    async calculateDemand() {
        const totalServers = this.controller.servers.size;
        const maxServers = this.config.get('dynamicServers.maxServers', 20);
        
        if (maxServers === 0) return 0;
        
        const utilization = totalServers / maxServers;
        
        // Factor in reserved servers
        const reservedCount = this.reservedServers.size;
        const warmCount = this.warmPool.size;
        const availableWarm = warmCount - reservedCount;
        
        // If we have no available warm servers, demand is high
        if (availableWarm <= 0) {
            return 1.0;
        }
        
        // Calculate based on recent request patterns
        const recentRequests = this.getRecentRequestRate();
        const capacity = availableWarm * 60; // Assume 60 requests/min per server
        
        const requestDemand = capacity > 0 ? recentRequests / capacity : 1.0;
        
        // Combine utilization and request demand
        return Math.min(1.0, (utilization + requestDemand) / 2);
    }

    getRecentRequestRate() {
        // TODO: Implement request rate tracking
        // For now, return a placeholder
        return 10; // requests per minute
    }

    // FIXED: Updated to accept count parameter
    async scaleUp(count = null) {
        const current = this.warmPool.size;
        const max = this.config.get('pool.maxServers', 10);
        
        if (current >= max) {
            this.logger.debug('Pool at maximum size');
            return [];
        }
        
        // If count not specified, use default scaling logic
        if (count === null) {
            // Scale by 50% or 3 servers, whichever is smaller
            const increment = Math.min(3, Math.ceil((max - current) * 0.5));
            count = Math.min(max - current, increment);
        } else {
            count = Math.min(max - current, count);
        }
        
        this.logger.info(`Scaling up pool by ${count} servers`);
        
        const added = [];
        for (let i = 0; i < count; i++) {
            try {
                const server = await this.addServerToPool();
                if (server) {
                    added.push(server.id);
                }
            } catch (error) {
                this.logger.error(`Failed to add server during scale up: ${error.message}`);
                break; // Stop if we hit an error (probably out of ports)
            }
        }
        
        return added;
    }

    // FIXED: Updated to accept count parameter
    async scaleDown(count = null) {
        const current = this.warmPool.size;
        const min = this.config.get('pool.minServers', 2);
        
        if (current <= min) {
            this.logger.debug('Pool at minimum size');
            return [];
        }
        
        // If count not specified, use default scaling logic
        if (count === null) {
            // Scale down by 30%
            const decrement = Math.ceil((current - min) * 0.3);
            count = Math.min(current - min, decrement);
        } else {
            count = Math.min(current - min, count);
        }
        
        this.logger.info(`Scaling down pool by ${count} servers`);
        
        const servers = Array.from(this.warmPool).slice(0, count);
        const removed = [];
        
        for (const serverId of servers) {
            if (!this.reservedServers.has(serverId)) {
                await this.removeServerFromPool(serverId);
                removed.push(serverId);
            }
        }
        
        return removed;
    }

    async scaleToMin() {
        const current = this.warmPool.size;
        const min = this.config.get('pool.minServers', 2);
        
        if (current >= min) {
            this.logger.debug(`Pool already at minimum size: ${current}/${min}`);
            return;
        }
        
        const needed = min - current;
        this.logger.info(`Scaling pool to minimum size: ${min} (need ${needed} more)`);
        
        const results = [];
        
        // Create servers sequentially to avoid port conflicts
        for (let i = 0; i < needed; i++) {
            try {
                const server = await this.addServerToPool();
                results.push({ status: 'success', server });
            } catch (error) {
                results.push({ status: 'failed', error });
                this.logger.error(`Failed to create pool server ${i + 1}/${needed}: ${error.message}`);
            }
        }
        
        const successful = results.filter(r => r.status === 'success').length;
        const failed = results.filter(r => r.status === 'failed').length;
        
        if (failed > 0) {
            this.logger.warn(`Pool scaling partial: ${successful} created, ${failed} failed`);
        } else {
            this.logger.info(`Pool scaled to ${this.warmPool.size} servers`);
        }
        
        // Emit update after scaling
        this.emit('poolUpdate', this.getStatus());
        
        return results;
    }

    // Add method to get total pool servers (warm + activating)
    getTotalPoolServers() {
        const warmCount = this.getWarmServers().length;
        const activatingCount = Array.from(this.controller.servers.values())
            .filter(s => s.type === 'pool' && s.status === 'starting')
            .length;
        return warmCount + activatingCount;
    }

    // FIXED: Updated to properly check state and emit events
    async checkAndScale() {
        if (!this.enabled) {
            this.logger.debug('Pool manager not enabled');
            return 'disabled';
        }
        
        if (this.scaling) {
            this.logger.debug('Already scaling, skipping check');
            return 'already-scaling';
        }

        this.scaling = true;
        
        try {
            const warmServers = this.getWarmServers();
            const warmCount = warmServers.length;
            const minWarm = this.config.get('pool.minWarm') || this.config.get('pool.minServers') || 2;
            const maxWarm = this.config.get('pool.maxWarm') || this.config.get('pool.maxServers') || 5;

            this.logger.info(`Pool check: ${warmCount} warm (min: ${minWarm}, max: ${maxWarm})`);

            let result = 'optimal';
            
            if (warmCount < minWarm) {
                const needed = minWarm - warmCount;
                this.logger.info(`Scaling up pool by ${needed} servers`);
                const added = await this.scaleUp(needed);
                this.emit('poolScaled', { action: 'up', count: added.length, servers: added });
                result = `scaled-up-${added.length}`;
            } else if (warmCount > maxWarm) {
                const excess = warmCount - maxWarm;
                this.logger.info(`Scaling down pool by ${excess} servers`);
                const removed = await this.scaleDown(excess);
                this.emit('poolScaled', { action: 'down', count: removed.length, servers: removed });
                result = `scaled-down-${removed.length}`;
            }

            // Emit status update
            this.emit('poolUpdate', this.getStatus());
            
            return result;
        } catch (error) {
            this.logger.error(`Error during pool scaling: ${error.message}`);
            return 'error';
        } finally {
            this.scaling = false;
        }
    }

    getNextAvailablePort() {
        const startPort = this.config.get('ports.rangeStart', 25600);
        const endPort = this.config.get('ports.rangeEnd', 25700);
        
        // Rebuild used ports set from all active servers
        this.usedPorts.clear();
        
        // Check dynamic servers
        this.controller.servers.forEach(server => {
            if (server.port) this.usedPorts.add(server.port);
        });
        
        // Check static servers
        if (this.controller.staticServers) {
            this.controller.staticServers.forEach(server => {
                if (server.port) this.usedPorts.add(server.port);
            });
        }
        
        // Add hub port if configured
        const hubConfig = this.config.get('servers.hub');
        if (hubConfig && hubConfig.port) {
            this.usedPorts.add(hubConfig.port);
        }
        
        // Find first available port
        for (let port = startPort; port <= endPort; port++) {
            if (!this.usedPorts.has(port)) {
                this.usedPorts.add(port); // Reserve it immediately
                return port;
            }
        }
        
        throw new Error(`No available ports in range ${startPort}-${endPort}`);
    }

    async addServerToPool() {
        try {
            const poolConfig = this.config.get('pool', {});
            const gameType = poolConfig.template || 'mini';
            
            // Just call the same method everyone uses
            const server = await this.controller.createDynamicServer({
                gameType,
                metadata: {
                    isPoolServer: true,
                    addedToPool: Date.now()
                }
            });
            
            if (server) {
                this.warmPool.add(server.id);
                this.logger.info(`Added server ${server.id} to warm pool`);
                this.emit('serverAddedToPool', server);
                this.emit('serverWarmed', server.id);
                return server;
            }
        } catch (error) {
            this.logger.error(`Failed to add server to pool: ${error.message}`);
            throw error;
        }
        
        return null;
    }

    async removeServerFromPool(serverId) {
        if (!this.warmPool.has(serverId)) return;
        
        try {
            // Use the same stop method
            await this.controller.stopDynamicServer(serverId);
            this.warmPool.delete(serverId);
            this.logger.info(`Removed server ${serverId} from warm pool`);
            this.emit('serverRemovedFromPool', serverId);
        } catch (error) {
            this.logger.error(`Failed to remove server from pool: ${error.message}`);
        }
    }

    async handleServerRequest(request) {
        const startTime = Date.now();
        this.metrics.totalRequests++;
        
        const {
            gameType,
            requester,
            priority = 'normal',
            requirements = {}
        } = request;
        
        this.logger.info(`Server requested: ${gameType} by ${requester}`);
        
        // Try to fulfill from warm pool
        const warmServer = await this.getWarmServer(gameType);
        
        if (warmServer) {
            this.metrics.poolHits++;
            const waitTime = Date.now() - startTime;
            this.updateAverageWaitTime(waitTime);
            
            await this.assignServer(warmServer, request);
            this.metrics.fulfilledRequests++;
            
            // Replenish pool
            this.addServerToPool().catch(err => {
                this.logger.error(`Failed to replenish pool: ${err.message}`);
            });
            
            return warmServer;
        }
        
        // No warm server available, create new one
        this.metrics.poolMisses++;
        
        try {
            const server = await this.controller.startDynamicServer({
                gameType,
                requestId: request.id,
                customConfig: requirements
            });
            
            if (server) {
                const waitTime = Date.now() - startTime;
                this.updateAverageWaitTime(waitTime);
                this.metrics.fulfilledRequests++;
                
                this.emit('serverAssigned', {
                    server,
                    request,
                    waitTime
                });
                
                return server;
            }
        } catch (error) {
            this.logger.error(`Failed to create server for request: ${error.message}`);
        }
        
        this.emit('requestFailed', request);
        return null;
    }

    async getWarmServer(gameType = 'mini') {
        for (const serverId of this.warmPool) {
            const server = this.controller.getServer(serverId);
            
            if (!server) {
                // Server doesn't exist, remove from pool
                this.warmPool.delete(serverId);
                continue;
            }
            
            // Check if it matches the game type
            const serverGameType = server.gameType || server.metadata?.gameType || 'mini';
            if (serverGameType === gameType && !this.reservedServers.has(serverId)) {
                // Reserve this server
                this.warmPool.delete(serverId);
                this.reservedServers.set(serverId, Date.now());
                
                this.logger.info(`Assigned warm server ${serverId} for ${gameType}`);
                
                // Replenish the pool
                this.addServerToPool().catch(err => {
                    this.logger.error(`Failed to replenish pool: ${err.message}`);
                });
                
                return server;
            }
        }
        
        return null; // No warm servers available
    }

    async assignServer(server, request) {
        // Configure server for specific game type if needed
        if (request.gameType && server.gameType !== request.gameType) {
            await this.reconfigureServer(server, request.gameType);
        }
        
        // Update server metadata
        server.metadata = {
            ...server.metadata,
            assignedTo: request.requester,
            assignedAt: Date.now(),
            requestId: request.id
        };
        
        this.emit('serverAssigned', {
            server,
            request,
            fromPool: true
        });
        
        this.logger.info(`Assigned server ${server.id} to ${request.requester}`);
    }

    async reconfigureServer(server, gameType) {
        this.logger.info(`Reconfiguring server ${server.id} for ${gameType}`);
        
        // Send reconfiguration command to server
        await this.controller.sendCommand(server.id, `changegame ${gameType}`);
        
        // Update server properties
        server.gameType = gameType;
        
        // Load appropriate plugins
        const template = this.config.getGameTemplate(gameType);
        if (template && template.plugins) {
            // TODO: Implement dynamic plugin loading
            this.logger.warn('Dynamic plugin loading not yet implemented');
        }
    }

    async handleServerRelease(serverId) {
        this.reservedServers.delete(serverId);
        
        const server = this.controller.getServer(serverId);
        if (!server || server.type !== 'dynamic') return;
        
        // Check if server should be returned to pool or stopped
        const shouldReturnToPool = 
            this.warmPool.size < this.config.get('pool.maxWarm', 5) &&
            server.status === 'ready' &&
            server.players.length === 0;
        
        if (shouldReturnToPool) {
            // Reset server
            await this.resetServer(server);
            
            // Add back to warm pool
            this.warmPool.add(serverId);
            this.logger.info(`Returned server ${serverId} to warm pool`);
        } else {
            // Stop the server
            await this.controller.stopDynamicServer(serverId);
        }
    }

    async resetServer(server) {
        this.logger.debug(`Resetting server ${server.id}`);
        
        // Clear metadata
        server.metadata = {};
        
        // Reset world if needed
        if (this.config.get('pool.resetWorlds', true)) {
            await this.controller.sendCommand(server.id, 'resetworld');
        }
        
        // Clear player data
        server.players = [];
    }

    async handleServerCrash(serverId) {
        // Remove from warm pool if present
        this.warmPool.delete(serverId);
        this.reservedServers.delete(serverId);
        
        // Replace crashed warm server
        if (this.warmPool.size < this.config.get('pool.minWarm', 2)) {
            this.addServerToPool().catch(err => {
                this.logger.error(`Failed to replace crashed server: ${err.message}`);
            });
        }
    }

    async removeUnhealthyServers() {
        const unhealthy = [];
        
        for (const serverId of this.warmPool) {
            const server = this.controller.getServer(serverId);
            
            if (!server) {
                unhealthy.push(serverId);
            } else if (server.status === 'stopped' || server.status === 'failed') {
                unhealthy.push(serverId);
            } else if (server.healthChecks && server.healthChecks.failed > 5) {
                // Increased threshold from 2 to 5
                unhealthy.push(serverId);
            }
            // Don't remove servers just because they're 'starting' or 'created'
        }
        
        for (const serverId of unhealthy) {
            this.logger.warn(`Removing unhealthy server ${serverId} from pool`);
            await this.removeServerFromPool(serverId);
        }
    }

    async drainPool() {
        this.logger.info('Draining warm pool');
        
        const servers = Array.from(this.warmPool);
        
        for (const serverId of servers) {
            await this.removeServerFromPool(serverId);
        }
        
        this.warmPool.clear();
        this.reservedServers.clear();
    }

    updateAverageWaitTime(waitTime) {
        const alpha = 0.2; // Exponential moving average factor
        this.metrics.averageWaitTime = 
            alpha * waitTime + (1 - alpha) * this.metrics.averageWaitTime;
    }

    async recordMetrics() {
        const metrics = {
            poolSize: this.warmPool.size,
            reservedServers: this.reservedServers.size,
            totalRequests: this.metrics.totalRequests,
            poolHitRate: this.metrics.totalRequests > 0 
                ? this.metrics.poolHits / this.metrics.totalRequests 
                : 0,
            averageWaitTime: this.metrics.averageWaitTime
        };
        
        this.emit('metrics', metrics);
        
        // Log metrics periodically
        this.logger.debug(`Pool metrics: ${JSON.stringify(metrics)}`);
    }

    // FIXED: Updated to provide better status information
    getStatus() {
        const warmServers = this.getWarmServers();
        return {
            isRunning: this.isRunning,
            enabled: this.enabled,
            scaling: this.scaling,
            warmPoolSize: this.warmPool.size,
            warmServersReady: warmServers.length,
            totalServers: this.getTotalPoolServers(),
            reservedServers: this.reservedServers.size,
            warmServers: Array.from(this.warmPool),
            metrics: this.metrics,
            config: {
                minWarm: this.config.get('pool.minWarm') || this.config.get('pool.minServers'),
                maxWarm: this.config.get('pool.maxWarm') || this.config.get('pool.maxServers'),
                enabled: this.config.get('pool.enabled')
            }
        };
    }
}

module.exports = PoolManager;