// api/ApiServer.js - Express API Server with Pool Integration

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const Logger = require('../src/utils/Logger');

class ApiServer {
    constructor(serverManager) {
        this.manager = serverManager;
        this.logger = new Logger('ApiServer');
        this.app = express();
        this.httpServer = http.createServer(this.app);
        this.io = new Server(this.httpServer, {
            cors: {
                origin: "*",
                methods: ["GET", "POST"]
            }
        });
        
        this.setupMiddleware();
        this.setupRoutes();
        this.setupWebSocket();
        this.setupPoolEventListeners(); // NEW: Setup pool event listeners
    }
    
    setupMiddleware() {
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        this.app.use(express.static(path.join(process.cwd(), 'public')));
        
        // CORS
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
            next();
        });
        
        // Request logging
        this.app.use((req, res, next) => {
            this.logger.debug(`${req.method} ${req.path}`);
            next();
        });
    }
    
    setupRoutes() {
        // Health check
        this.app.get('/health', (req, res) => {
            res.json({ status: 'ok', timestamp: Date.now() });
        });
        
        // Status endpoint
        this.app.get('/api/status', (req, res) => {
            const status = this.getManagerStatus();
            res.json(status);
        });
        
        // Static servers
        this.app.post('/api/static/:name/start', async (req, res) => {
            try {
                const server = await this.manager.controller.startStaticServer(req.params.name);
                res.json({ success: true, server: this.manager.controller.getServerInfo(server.id) });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
        
        this.app.post('/api/static/:name/stop', async (req, res) => {
            try {
                await this.manager.controller.stopStaticServer(req.params.name);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
        
        this.app.post('/api/static/:name/restart', async (req, res) => {
            try {
                await this.manager.controller.stopStaticServer(req.params.name);
                await new Promise(resolve => setTimeout(resolve, 2000));
                const server = await this.manager.controller.startStaticServer(req.params.name);
                res.json({ success: true, server: this.manager.controller.getServerInfo(server.id) });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
        
        // Dynamic servers
        this.app.post('/api/dynamic/start', async (req, res) => {
            try {
                const { gameType, count = 1 } = req.body;
                const servers = [];
                
                for (let i = 0; i < count; i++) {
                    const server = await this.manager.controller.startDynamicServer({ gameType });
                    servers.push(this.manager.controller.getServerInfo(server.id));
                }
                
                res.json({ success: true, servers });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
        
        this.app.post('/api/dynamic/:id/stop', async (req, res) => {
            try {
                await this.manager.controller.stopDynamicServer(req.params.id);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
        
        // Console endpoints
        this.app.get('/api/console/:id', (req, res) => {
            const console = this.manager.controller.getConsole(req.params.id);
            res.json({ console });
        });
        
        this.app.post('/api/console/:id/command', async (req, res) => {
            try {
                const { command } = req.body;
                await this.manager.controller.sendCommand(req.params.id, command);
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
        
        // UPDATED: Pool management routes
        this.setupPoolRoutes();
        
        // Config endpoints
        this.app.get('/api/config', (req, res) => {
            const config = this.manager.config.config;
            res.json(config);
        });
        
        this.app.post('/api/config', async (req, res) => {
            try {
                const { path, value } = req.body;
                this.manager.config.set(path, value);
                await this.manager.config.save();
                res.json({ success: true });
            } catch (error) {
                res.status(400).json({ success: false, error: error.message });
            }
        });
        
        // Catch all for SPA
        this.app.get('*', (req, res) => {
            const indexPath = path.join(process.cwd(), 'public', 'index.html');
            if (require('fs').existsSync(indexPath)) {
                res.sendFile(indexPath);
            } else {
                res.send(`
                    <h1>Server Manager API</h1>
                    <p>API is running on port ${this.manager.config.get('ports.apiPort', 3000)}</p>
                    <p>Dashboard not found. Create public/index.html for web interface.</p>
                    <h2>API Endpoints:</h2>
                    <ul>
                        <li>GET /api/status - Get system status</li>
                        <li>POST /api/static/:name/start - Start static server</li>
                        <li>POST /api/static/:name/stop - Stop static server</li>
                        <li>POST /api/dynamic/start - Start dynamic server</li>
                        <li>POST /api/dynamic/:id/stop - Stop dynamic server</li>
                        <li>GET /api/console/:id - Get server console</li>
                        <li>POST /api/console/:id/command - Send command to server</li>
                        <li>GET /api/pool/status - Get pool status</li>
                        <li>POST /api/pool/scale - Trigger pool scaling</li>
                    </ul>
                `);
            }
        });
    }
    
    // NEW: Setup pool-specific routes
    setupPoolRoutes() {
        const poolManager = this.manager.poolManager || this.manager.pool;
        
        if (!poolManager) {
            this.logger.warn('Pool manager not available, skipping pool routes');
            return;
        }
        
        // Get pool status
        this.app.get('/api/pool/status', (req, res) => {
            try {
                const status = poolManager.getStatus();
                res.json(status);
            } catch (error) {
                this.logger.error('Error getting pool status:', error);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Manual scale trigger
        this.app.post('/api/pool/scale', async (req, res) => {
            try {
                this.logger.info('Manual pool scale requested via API');
                
                const result = await poolManager.checkAndScale();
                const status = poolManager.getStatus();
                
                res.json({
                    success: true,
                    result: result,
                    ...status
                });
            } catch (error) {
                this.logger.error('Error scaling pool:', error);
                res.status(500).json({ 
                    success: false,
                    error: error.message 
                });
            }
        });
        
        // Scale up by specific amount
        this.app.post('/api/pool/scale-up', async (req, res) => {
            try {
                const count = parseInt(req.body.count) || 1;
                this.logger.info(`Manual scale up by ${count} requested`);
                
                const added = await poolManager.scaleUp(count);
                const status = poolManager.getStatus();
                
                res.json({
                    success: true,
                    added: added,
                    ...status
                });
            } catch (error) {
                this.logger.error('Error scaling up pool:', error);
                res.status(500).json({ error: error.message });
            }
        });
        
        // Scale down by specific amount
        this.app.post('/api/pool/scale-down', async (req, res) => {
            try {
                const count = parseInt(req.body.count) || 1;
                this.logger.info(`Manual scale down by ${count} requested`);
                
                const removed = await poolManager.scaleDown(count);
                const status = poolManager.getStatus();
                
                res.json({
                    success: true,
                    removed: removed,
                    ...status
                });
            } catch (error) {
                this.logger.error('Error scaling down pool:', error);
                res.status(500).json({ error: error.message });
            }
        });
    }
    
    setupWebSocket() {
        this.io.on('connection', (socket) => {
            this.logger.info(`WebSocket client connected: ${socket.id}`);
            
            // Send initial status
            socket.emit('status', this.getManagerStatus());
            
            // UPDATED: Send initial pool status
            const poolManager = this.manager.poolManager || this.manager.pool;
            if (poolManager) {
                socket.emit('pool:update', poolManager.getStatus());
            }
            
            // Subscribe to console
            socket.on('subscribeConsole', (serverId) => {
                socket.join(`console:${serverId}`);
                
                const console = this.manager.controller.getConsole(serverId, 100);
                socket.emit('consoleHistory', { serverId, lines: console });
            });
            
            socket.on('unsubscribeConsole', (serverId) => {
                socket.leave(`console:${serverId}`);
            });
            
            // Send command
            socket.on('sendCommand', async (data) => {
                const { serverId, command } = data;
                try {
                    await this.manager.controller.sendCommand(serverId, command);
                    socket.emit('commandSent', { serverId, command });
                } catch (error) {
                    socket.emit('error', { message: error.message });
                }
            });
            
            // NEW: Pool-specific WebSocket handlers
            socket.on('pool:status', (callback) => {
                if (poolManager) {
                    const status = poolManager.getStatus();
                    if (callback) callback(status);
                }
            });
            
            socket.on('pool:scale', async (callback) => {
                try {
                    if (!poolManager) {
                        throw new Error('Pool manager not available');
                    }
                    
                    this.logger.info('Pool scale requested via WebSocket');
                    const result = await poolManager.checkAndScale();
                    
                    if (callback) {
                        callback({ 
                            success: true, 
                            result,
                            status: poolManager.getStatus()
                        });
                    }
                } catch (error) {
                    this.logger.error('Error scaling pool via WebSocket:', error);
                    if (callback) {
                        callback({ 
                            success: false, 
                            error: error.message 
                        });
                    }
                }
            });
            
            socket.on('pool:scaleUp', async (count, callback) => {
                try {
                    if (!poolManager) {
                        throw new Error('Pool manager not available');
                    }
                    
                    const added = await poolManager.scaleUp(count || 1);
                    
                    if (callback) {
                        callback({
                            success: true,
                            added,
                            status: poolManager.getStatus()
                        });
                    }
                } catch (error) {
                    if (callback) {
                        callback({
                            success: false,
                            error: error.message
                        });
                    }
                }
            });
            
            socket.on('pool:scaleDown', async (count, callback) => {
                try {
                    if (!poolManager) {
                        throw new Error('Pool manager not available');
                    }
                    
                    const removed = await poolManager.scaleDown(count || 1);
                    
                    if (callback) {
                        callback({
                            success: true,
                            removed,
                            status: poolManager.getStatus()
                        });
                    }
                } catch (error) {
                    if (callback) {
                        callback({
                            success: false,
                            error: error.message
                        });
                    }
                }
            });
            
            // Send status updates
            const statusInterval = setInterval(() => {
                socket.emit('status', this.getManagerStatus());
            }, 2000);
            
            socket.on('disconnect', () => {
                clearInterval(statusInterval);
                this.logger.info(`WebSocket client disconnected: ${socket.id}`);
            });
        });
        
        // Forward console output to websocket
        if (this.manager.controller) {
            this.manager.controller.on('console', ({ serverId, line }) => {
                this.io.to(`console:${serverId}`).emit('consoleLine', {
                    serverId,
                    line,
                    timestamp: Date.now()
                });
            });
        }
    }
    
    // NEW: Setup pool event listeners
    setupPoolEventListeners() {
        const poolManager = this.manager.poolManager || this.manager.pool;
        
        if (!poolManager) {
            this.logger.warn('Pool manager not available for event listeners');
            return;
        }
        
        // Listen to PoolManager events and broadcast to clients
        poolManager.on('poolUpdate', (status) => {
            this.io.emit('pool:update', status);
        });
        
        poolManager.on('poolScaled', (data) => {
            this.io.emit('pool:scaled', data);
            this.io.emit('pool:update', poolManager.getStatus());
        });
        
        poolManager.on('serverWarmed', (serverId) => {
            this.io.emit('pool:serverWarmed', serverId);
            this.io.emit('pool:update', poolManager.getStatus());
        });
        
        poolManager.on('serverAddedToPool', (server) => {
            this.io.emit('pool:serverAdded', {
                serverId: server.id,
                gameType: server.gameType || 'mini'
            });
            this.io.emit('pool:update', poolManager.getStatus());
        });
        
        poolManager.on('serverRemovedFromPool', (serverId) => {
            this.io.emit('pool:serverRemoved', serverId);
            this.io.emit('pool:update', poolManager.getStatus());
        });
        
        // Also listen to server controller events that might affect pool
        if (this.manager.controller) {
            this.manager.controller.on('serverStarted', (serverId) => {
                // Emit pool update when any server starts
                if (poolManager) {
                    this.io.emit('pool:update', poolManager.getStatus());
                }
            });
            
            this.manager.controller.on('serverStopped', (serverId) => {
                // Emit pool update when any server stops
                if (poolManager) {
                    this.io.emit('pool:update', poolManager.getStatus());
                }
            });
        }
        
        // Periodic pool status updates (every 5 seconds)
        setInterval(() => {
            if (poolManager && poolManager.enabled) {
                this.io.emit('pool:update', poolManager.getStatus());
            }
        }, 5000);
    }
    
    getManagerStatus() {
        const servers = this.manager.controller ? this.manager.controller.getAllServers() : { static: [], dynamic: [] };
        const poolManager = this.manager.poolManager || this.manager.pool; // FIXED: Check both possible names
        const poolStatus = poolManager ? poolManager.getStatus() : null;
        
        return {
            timestamp: Date.now(),
            staticServers: servers.static.map(s => this.manager.controller.getServerInfo(s.id)),
            dynamicServers: servers.dynamic.map(s => this.manager.controller.getServerInfo(s.id)),
            pool: poolStatus,
            redis: this.manager.redis ? this.manager.redis.connected : false,
            config: {
                staticServersConfigured: Object.keys(this.manager.config.get('staticServers', {})),
                gameTemplates: Object.keys(this.manager.config.get('gameTemplates', {}))
            }
        };
    }
    
    async start() {
        const port = this.manager.config.get('ports.apiPort', 3000);
        
        return new Promise((resolve) => {
            this.httpServer.listen(port, () => {
                this.logger.info(`API Server running on http://localhost:${port}`);
                resolve();
            });
        });
    }
    
    async stop() {
        return new Promise((resolve) => {
            this.httpServer.close(() => {
                this.logger.info('API Server stopped');
                resolve();
            });
        });
    }
}

module.exports = ApiServer;