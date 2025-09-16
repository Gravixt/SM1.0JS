// src/ServerController.js - Server Lifecycle Management

const { spawn } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const EventEmitter = require('events');
const { v4: uuidv4 } = require('uuid');
const Logger = require('./utils/Logger');
const NetworkManager = require('./NetworkManager');
const PluginBridge = require('./PluginBridge');

class ServerController extends EventEmitter {
    constructor(configManager, redisManager) {
        super();
        this.config = configManager;
        this.redis = redisManager;
        this.servers = new Map();
        this.staticServers = new Map();
        this.proxy = null;
        this.network = new NetworkManager(configManager);
        this.pluginBridge = new PluginBridge(this, redisManager);
        this.logger = new Logger('ServerController');
        
        // Track registered servers to prevent duplicates
        this.registeredWithProxy = new Set();
    }

    async initialize() {
        this.logger.info('Initializing server controller...');
        
        // Setup plugin bridge
        await this.pluginBridge.initialize();
           
        // Setup cleanup handlers
        this.setupCleanupHandlers();
        
        this.logger.info('Server controller initialized');
    }

    async startStaticServer(name) {
        if (this.staticServers.has(name)) {
            throw new Error(`Static server ${name} is already running`);
        }

        const serverConfig = this.config.getStaticServerConfig(name);
        if (!serverConfig) {
            throw new Error(`Static server ${name} not configured`);
        }

        this.logger.info(`Starting static server: ${name}`);
        
        // Ensure the server directory exists and has proper forwarding config
        const serverDir = this.getServerDirectory(name, 'static');
        if (this.forwardingSecret) {
            await this.configurePaperForwarding(serverDir, this.forwardingSecret);
        }
        
        const server = await this.createServer({
            id: name,
            type: 'static',
            ...serverConfig
        });
        
        this.staticServers.set(name, server);
        
        await this.startServer(server);
        
        this.emit('staticServerStarted', server);
        
        return server;
    }

    async startStaticServer(name) {
        if (this.staticServers.has(name)) {
            throw new Error(`Static server ${name} is already running`);
        }

        const serverConfig = this.config.getStaticServerConfig(name);
        if (!serverConfig) {
            throw new Error(`Static server ${name} not configured`);
        }

        this.logger.info(`Starting static server: ${name}`);
        
        const server = await this.createServer({
            id: name,
            type: 'static',
            ...serverConfig
        });
        
        this.staticServers.set(name, server);
        
        await this.startServer(server);
        
        this.emit('staticServerStarted', server);
        
        return server;
    }

    async stopStaticServer(name) {
        const server = this.staticServers.get(name);
        if (!server) {
            throw new Error(`Static server ${name} not found`);
        }

        await this.stopServer(server);
        
        this.staticServers.delete(name);
        
        this.emit('staticServerStopped', name);
    }

    async startDynamicServer(options = {}) {
        const {
            gameType = this.config.get('dynamicServers.defaultTemplate'),
            requestId = uuidv4(),
            playerCount = null,
            customConfig = {}
        } = options;

        const serverId = this.generateServerId(gameType);
        const port = await this.network.allocatePort();
        
        if (!port) {
            throw new Error('No available ports');
        }

        const gameTemplate = this.config.getGameTemplate(gameType);
        if (!gameTemplate) {
            throw new Error(`Game template ${gameType} not found`);
        }

        this.logger.info(`Starting dynamic server: ${serverId} on port ${port}`);
        
        const server = await this.createServer({
            id: serverId,
            type: 'dynamic',
            gameType,
            port,
            requestId,
            ...gameTemplate,
            ...customConfig
        });
        
        this.servers.set(serverId, server);
        
        await this.startServer(server);
        
        this.emit('dynamicServerStarted', server);
        
        // Notify plugins about new server
        await this.pluginBridge.notifyServerReady(server);
        
        return server;
    }

    async stopDynamicServer(serverId) {
        const server = this.servers.get(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }

        await this.stopServer(server);
        
        this.servers.delete(serverId);
        
        // Release port
        await this.network.releasePort(server.port);
        
        // Clean up server directory
        if (server.cleanupOnStop !== false) {
            await this.cleanupServerDirectory(server);
        }
        
        this.emit('dynamicServerStopped', serverId);
    }

    async configurePaperForwarding(serverDir, forwardingSecret) {
        // Create paper-global.yml with the forwarding configuration
        const paperGlobalConfig = `
    # Paper Global Configuration
    # This file is automatically generated by ServerManager

    proxies:
    velocity:
        enabled: true
        online-mode: false
        secret: '${forwardingSecret}'

    console:
    enable-brigadier-highlighting: true
    enable-brigadier-completions: true

    messages:
    kick:
        connection-throttle: "&cConnection throttled! Please wait before reconnecting."
    `;

        const paperConfigPath = path.join(serverDir, 'config', 'paper-global.yml');
        await fs.ensureDir(path.join(serverDir, 'config'));
        await fs.writeFile(paperConfigPath, paperGlobalConfig.trim());
        
        this.logger.debug(`Configured Paper forwarding for ${serverDir}`);
    }

    async createServer(options) {
        const {
            id,
            type,
            gameType,
            port,
            jar,
            configTemplate = 'minimal',
            plugins = [],
            worldType = 'void',
            maxPlayers = 20,
            requestId
        } = options;

        const jarConfig = this.config.getJarConfig(jar);
        if (!jarConfig) {
            throw new Error(`JAR configuration not found: ${jar}`);
        }

        const serverDir = this.getServerDirectory(id, type);
        await fs.ensureDir(serverDir);

        // Generate configuration
        const config = await this.config.generateServerConfig(id, {
            template: configTemplate,
            gameType,
            plugins,
            port,
            settings: {
                'max-players': maxPlayers,
                'level-type': worldType === 'void' ? 'FLAT' : 'DEFAULT',
                'online-mode': false  // MUST be false for Velocity forwarding
            }
        });

        // Write configuration files
        await this.config.writeServerConfig(serverDir, config);
        
        // Configure Paper forwarding if we have a forwarding secret
        if (this.forwardingSecret) {
            await this.configurePaperForwarding(serverDir, this.forwardingSecret);
        }

        // Copy plugins
        await this.copyPlugins(serverDir, plugins);

        const server = {
            id,
            type,
            gameType,
            port,
            jarConfig,
            directory: serverDir,
            process: null,
            pid: null,
            status: 'created',
            players: [],
            console: [],
            maxConsoleLines: 500,
            startedAt: null,
            requestId,
            configTemplate,
            plugins,
            worldType,
            maxPlayers,
            metadata: {},
            healthChecks: {
                failed: 0,
                lastCheck: null
            }
        };

        return server;
    }

    async startServer(server) {
        const jarPath = path.resolve(server.jarConfig.path);
        
        if (!await fs.pathExists(jarPath)) {
            throw new Error(`JAR file not found: ${jarPath}`);
        }

        const javaPath = this.config.getJavaPath(server.jarConfig.javaVersion);
        
        const args = this.buildJavaArgs(server.jarConfig, jarPath);
        
        this.logger.info(`Starting server ${server.id} with Java ${server.jarConfig.javaVersion}`);
        
        const serverProcess = spawn(javaPath, args, {
            cwd: server.directory,
            shell: false
        });

        server.process = serverProcess;
        server.pid = serverProcess.pid;
        server.status = 'starting';
        server.startedAt = Date.now();

        this.setupProcessHandlers(server, serverProcess);

        // Wait for server to be ready
        const ready = await this.waitForReady(server);
        
        if (!ready) {
            throw new Error(`Server ${server.id} failed to start`);
        }

        server.status = 'running';
        
        // Start health checks
        this.startHealthChecks(server);
        
        return server;
    }

    async registerWithVelocity(server) {
        if (!this.redis || !this.redis.connected) {
            this.logger.warn('Cannot register with Velocity: Redis not connected');
            return;
        }
        
        // Don't register if proxy isn't ready
        if (!this.proxy || this.proxy.status !== 'ready') {
            this.logger.warn('Cannot register with Velocity: Proxy not ready');
            return;
        }
        
        // Prevent duplicate registrations
        if (server.registeredWithVelocity) {
            this.logger.debug(`Server ${server.id} already registered with Velocity`);
            return;
        }
        
        const message = {
            id: server.id,  // The plugin expects 'id' not 'serverId'
            host: '127.0.0.1',  // The plugin expects 'host' not 'address'
            port: server.port,
            type: server.type || 'dynamic',
            gameType: server.gameType || '',
            maxPlayers: server.maxPlayers || 20,
            metadata: server.metadata || {}
        };
        
        // Use the correct channel name
        await this.redis.publish('server:register', JSON.stringify(message));
        server.registeredWithVelocity = true;
        this.logger.info(`Published registration for server ${server.id} to Velocity`);
    }

    async unregisterFromVelocity(serverId) {
        const server = this.getServer(serverId);
        if (!server) return;
        
        if (!this.redis || !this.redis.connected) {
            this.logger.warn('Cannot unregister from Velocity: Redis not connected');
            return;
        }
        
        // Only unregister if it was registered
        if (!server.registeredWithVelocity) {
            this.logger.debug(`Server ${serverId} was not registered with Velocity`);
            return;
        }
        
        try {
            const message = {
                id: serverId,  // The plugin expects 'id' not 'serverId'
                timestamp: Date.now()
            };
            
            // Use the correct channel name
            await this.redis.publish('server:unregister', JSON.stringify(message));
            server.registeredWithVelocity = false;
            this.logger.info(`Published unregistration for server ${serverId} to Velocity`);
            
        } catch (error) {
            this.logger.error(`Failed to unregister server ${serverId} from Velocity: ${error.message}`);
        }
    }

    async stopServer(serverId) {  // Takes serverId as string
        const server = this.getServer(serverId);
        if (!server) {
            throw new Error(`Server ${serverId} not found`);
        }
        
        this.logger.info(`Stopping server ${serverId} (type: ${server.type}, status: ${server.status})`);
        
        // Update status
        server.status = 'stopping';
        this.emit('serverStateChange', serverId, 'stopping');
        
        // Stop the server process
        if (server.process) {
            this.logger.info(`Sending stop command to server ${serverId}`);
            
            try {
                // Send stop command
                server.process.stdin.write('stop\n');
                
                // Wait for process to exit with timeout
                await new Promise((resolve, reject) => {
                    let processExited = false;
                    
                    const timeout = setTimeout(() => {
                        if (!processExited && server.process && !server.process.killed) {
                            this.logger.warn(`Server ${serverId} didn't stop gracefully, force killing...`);
                            server.process.kill('SIGKILL');
                        }
                        resolve();
                    }, 10000);  // 10 second timeout
                    
                    if (server.process) {
                        server.process.once('exit', (code) => {
                            processExited = true;
                            this.logger.info(`Server ${serverId} process exited with code ${code}`);
                            clearTimeout(timeout);
                            resolve();
                        });
                        
                        server.process.once('error', (err) => {
                            this.logger.error(`Error stopping server ${serverId}: ${err.message}`);
                            clearTimeout(timeout);
                            resolve();  // Continue even if there's an error
                        });
                    }
                });
            } catch (error) {
                this.logger.error(`Failed to stop server ${serverId}: ${error.message}`);
                // Try to force kill if stop command failed
                if (server.process && !server.process.killed) {
                    server.process.kill('SIGKILL');
                }
            }
        } else {
            this.logger.warn(`Server ${serverId} has no process to stop`);
        }
        
        // Clean up
        server.status = 'stopped';
        server.process = null;
        server.registeredWithVelocity = false;
        
        this.logger.info(`Server ${serverId} stopped successfully`);
        this.emit('serverStopped', serverId);
    }

    buildJavaArgs(jarConfig, jarPath) {
        const args = [
            `-Xmx${jarConfig.maxMemory || '2G'}`,
            `-Xms${jarConfig.minMemory || '512M'}`
        ];

        if (jarConfig.flags) {
            args.push(...jarConfig.flags);
        }

        args.push('-jar', jarPath, 'nogui');
        
        return args;
    }

    setupProcessHandlers(server, process) {
        process.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(line => line.trim());
            
            for (const line of lines) {
                this.handleConsoleOutput(server, line);
            }
        });

        process.stderr.on('data', (data) => {
            this.logger.error(`[${server.id}] ${data}`);
            this.handleConsoleOutput(server, `[ERROR] ${data}`);
        });

        process.on('exit', (code) => {
            this.logger.info(`[${server.id}] Process exited with code ${code}`);
            this.handleServerExit(server, code);
        });

        process.on('error', (error) => {
            this.logger.error(`[${server.id}] Process error: ${error.message}`);
            this.handleServerError(server, error);
        });
    }

    handleConsoleOutput(server, line) {
        // Add to console buffer
        server.console.push({
            timestamp: Date.now(),
            line
        });

        // Trim console buffer
        if (server.console.length > server.maxConsoleLines) {
            server.console.shift();
        }

        // Emit console event
        this.emit('console', {
            serverId: server.id,
            line
        });

        // Parse important messages
        this.parseConsoleMessage(server, line);
    }

    parseConsoleMessage(server, line) {
        // Server ready detection - look for "Done" message
        if (line.includes('Done (') && line.includes('s)!')) {
            this.logger.info(`Server ${server.id} is ready`);
            server.status = 'ready';
            this.emit('serverReady', server);
            
            // Notify Redis that server is ready
            if (this.redis && this.redis.connected) {
                this.redis.notifyServerRegistered(server);
            }
        }

        // Player join/quit detection - handle different log formats
        if (line.includes('joined the game') || line.includes('UUID of player')) {
            let playerName = null;
            // Try different patterns
            const patterns = [
                /(\w+) joined the game/,
                /UUID of player (\w+) is/,
                /\[Server\] (\w+) joined the game/
            ];
            
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    playerName = match[1];
                    break;
                }
            }
            
            if (playerName) {
                this.handlePlayerJoin(server, playerName);
            }
        }

        if (line.includes('left the game') || line.includes('lost connection')) {
            let playerName = null;
            const patterns = [
                /(\w+) left the game/,
                /(\w+) lost connection/,
                /\[Server\] (\w+) left the game/
            ];
            
            for (const pattern of patterns) {
                const match = line.match(pattern);
                if (match) {
                    playerName = match[1];
                    break;
                }
            }
            
            if (playerName) {
                this.handlePlayerQuit(server, playerName);
            }
        }

        // Error detection
        if (line.toLowerCase().includes('error') || line.includes('Exception')) {
            this.logger.error(`Error in server ${server.id}: ${line}`);
            this.emit('serverError', {
                serverId: server.id,
                error: line
            });
        }
    }

    handlePlayerJoin(server, playerName) {
        if (!server.players.includes(playerName)) {
            server.players.push(playerName);
        }

        this.emit('playerJoin', {
            serverId: server.id,
            player: playerName
        });

        // Notify via Redis
        if (this.redis) {
            this.redis.publish('player:join', {
                server: server.id,
                player: playerName,
                timestamp: Date.now()
            });
        }
    }

    handlePlayerQuit(server, playerName) {
        server.players = server.players.filter(p => p !== playerName);

        this.emit('playerQuit', {
            serverId: server.id,
            player: playerName
        });

        // Notify via Redis
        if (this.redis) {
            this.redis.publish('player:quit', {
                server: server.id,
                player: playerName,
                timestamp: Date.now()
            });
        }

        // Check if server should be stopped (dynamic only)
        if (server.type === 'dynamic' && server.players.length === 0) {
            this.scheduleEmptyServerShutdown(server);
        }
    }

    scheduleEmptyServerShutdown(server) {
        const timeout = this.config.get('dynamicServers.emptyTimeout', 300000); // 5 minutes
        
        if (!this.config.get('dynamicServers.shutdownEmpty', true)) {
            return;
        }

        if (server.emptyTimeout) {
            clearTimeout(server.emptyTimeout);
        }

        server.emptyTimeout = setTimeout(() => {
            if (server.players.length === 0) {
                this.logger.info(`Stopping empty server ${server.id}`);
                this.stopDynamicServer(server.id).catch(err => {
                    this.logger.error(`Failed to stop empty server: ${err.message}`);
                });
            }
        }, timeout);
    }

    async waitForReady(server, timeout = 30000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            // Check if server marked itself as ready
            if (server.status === 'ready') {
                return true;
            }

            // Check if process died
            if (!server.process || server.process.killed) {
                return false;
            }

            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        // If we haven't seen "Done" message but server is running, assume it's ready
        if (server.process && !server.process.killed) {
            this.logger.warn(`Server ${server.id} timeout but process running, marking as ready`);
            server.status = 'ready';
            return true;
        }

        return false;
    }

    startHealthChecks(server) {
        const interval = this.config.get('dynamicServers.healthCheckInterval', 10000);
        
        server.healthCheckInterval = setInterval(async () => {
            const healthy = await this.checkServerHealth(server);
            
            if (!healthy) {
                server.healthChecks.failed++;
                
                if (server.healthChecks.failed >= 3) {
                    this.logger.error(`Server ${server.id} failed health checks, restarting...`);
                    await this.restartServer(server);
                }
            } else {
                server.healthChecks.failed = 0;
            }
            
            server.healthChecks.lastCheck = Date.now();
        }, interval);
    }

    async checkServerHealth(server) {
        // Check process
        if (!server.process || server.process.killed) {
            return false;
        }

        // Check port
        const portResponding = await this.network.checkPort(server.port);
        if (!portResponding) {
            return false;
        }

        // TODO: Add more health checks (memory usage, TPS, etc.)
        
        return true;
    }

    async restartServer(server) {
        this.logger.info(`Restarting server ${server.id}`);
        
        // Store metadata
        const metadata = {
            players: [...server.players],
            gameType: server.gameType,
            customConfig: server.customConfig
        };

        // Stop server
        await this.stopServer(server);
        
        // Wait a moment
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Start server
        await this.startServer(server);
        
        // Restore metadata
        server.metadata = metadata;
        
        this.emit('serverRestarted', server);
    }

    handleServerExit(server, code) {
        server.status = 'stopped';
        server.process = null;
        server.pid = null;

        if (code !== 0) {
            this.logger.error(`Server ${server.id} crashed with code ${code}`);
            this.emit('serverCrash', {
                serverId: server.id,
                code
            });

            // Auto-restart static servers
            if (server.type === 'static') {
                this.logger.info(`Auto-restarting static server ${server.id}`);
                setTimeout(() => {
                    this.startStaticServer(server.id).catch(err => {
                        this.logger.error(`Failed to restart ${server.id}: ${err.message}`);
                    });
                }, 5000);
            }
        }
    }

    handleServerError(server, error) {
        this.logger.error(`Server ${server.id} error: ${error.message}`);
        this.emit('serverError', {
            serverId: server.id,
            error: error.message
        });
    }

    async copyPlugins(serverDir, pluginList) {
        const pluginsDir = path.join(serverDir, 'plugins');
        await fs.ensureDir(pluginsDir);

        for (const plugin of pluginList) {
            const pluginPath = path.join(this.config.get('paths.plugins'), plugin);
            
            if (await fs.pathExists(pluginPath)) {
                const stat = await fs.stat(pluginPath);
                
                if (stat.isDirectory()) {
                    // Copy entire plugin directory
                    await fs.copy(pluginPath, path.join(pluginsDir, plugin));
                } else {
                    // Copy single plugin file
                    await fs.copy(pluginPath, path.join(pluginsDir, path.basename(pluginPath)));
                }
            } else {
                this.logger.warn(`Plugin not found: ${plugin}`);
            }
        }
    }

    async cleanupServerDirectory(server) {
        try {
            await fs.remove(server.directory);
            this.logger.info(`Cleaned up directory for server ${server.id}`);
        } catch (error) {
            this.logger.error(`Failed to cleanup server directory: ${error.message}`);
        }
    }

    getServerDirectory(id, type) {
        const baseDir = this.config.get('paths.servers');
        const subDir = type === 'static' ? 'static' : 'dynamic';
        return path.join(baseDir, subDir, id);
    }

    setupCleanupHandlers() {
        const cleanup = async () => {
            this.logger.info('Shutting down all servers...');
            
            // Stop proxy first
            if (this.proxy) {
                await this.stopProxy().catch(err => {
                    this.logger.error(`Failed to stop proxy: ${err.message}`);
                });
            }
            
            // Stop all dynamic servers
            for (const serverId of this.servers.keys()) {
                await this.stopDynamicServer(serverId).catch(err => {
                    this.logger.error(`Failed to stop ${serverId}: ${err.message}`);
                });
            }
            
            // Stop all static servers
            for (const serverId of this.staticServers.keys()) {
                await this.stopStaticServer(serverId).catch(err => {
                    this.logger.error(`Failed to stop ${serverId}: ${err.message}`);
                });
            }
            
            process.exit(0);
        };
        
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);
    }

    // Public API methods
    
    getServer(serverId) {
        return this.servers.get(serverId) || this.staticServers.get(serverId);
    }
    
    getAllServers() {
        return {
            static: Array.from(this.staticServers.values()),
            dynamic: Array.from(this.servers.values())
        };
    }
    
    getServerInfo(serverId) {
        const server = this.getServer(serverId);
        if (!server) return null;
        
        return {
            id: server.id,
            type: server.type,
            gameType: server.gameType,
            port: server.port,
            status: server.status,
            players: server.players,
            playerCount: server.players.length,
            maxPlayers: server.maxPlayers,
            uptime: server.startedAt ? Date.now() - server.startedAt : 0,
            pid: server.pid,
            jarVersion: server.jarConfig ? path.basename(server.jarConfig.path) : 'unknown',
            metadata: server.metadata
        };
    }
    
    async sendCommand(serverId, command) {
        const server = this.getServer(serverId);
        if (!server || !server.process) {
            throw new Error(`Server ${serverId} not running`);
        }
        
        server.process.stdin.write(command + '\n');
        this.logger.info(`Sent command to ${serverId}: ${command}`);
    }
    
    getConsole(serverId, lines = 100) {
        const server = this.getServer(serverId);
        if (!server) return [];
        
        return server.console.slice(-lines);
    }
    
    // Velocity Proxy Management
    
    async startProxy() {
        const proxyConfig = this.config.get('proxy');
        if (!proxyConfig || !proxyConfig.enabled) {
            this.logger.info('Proxy is disabled in configuration');
            return;
        }

        if (this.proxy) {
            this.logger.warn('Proxy is already running');
            return;
        }

        this.logger.info(`Starting ${proxyConfig.type} proxy...`);
        
        const jarConfig = this.config.getJarConfig(proxyConfig.jar);
        if (!jarConfig) {
            throw new Error(`JAR configuration not found: ${proxyConfig.jar}`);
        }

        const proxyDir = path.resolve(proxyConfig.directory || './servers/velocity');
        await fs.ensureDir(proxyDir);
        
        // Create velocity config if it doesn't exist
        const velocityConfigPath = path.join(proxyDir, 'velocity.toml');
        if (!await fs.pathExists(velocityConfigPath)) {
            await this.createVelocityConfig(proxyDir, proxyConfig.port);
        }
        
        // CREATE THE FORWARDING SECRET FILE
        const forwardingSecretPath = path.join(proxyDir, 'forwarding.secret');
        if (!await fs.pathExists(forwardingSecretPath)) {
            const crypto = require('crypto');
            const secret = crypto.randomBytes(32).toString('hex');
            await fs.writeFile(forwardingSecretPath, secret);
            this.logger.info('Created forwarding secret file');
            
            // Also save this secret for Paper servers to use
            this.forwardingSecret = secret;
        } else {
            // Read existing secret
            this.forwardingSecret = await fs.readFile(forwardingSecretPath, 'utf8');
        }
        
        // Copy plugins
        const pluginsDir = path.join(proxyDir, 'plugins');
        await fs.ensureDir(pluginsDir);
        
        // Copy ServerManager plugin JAR if it exists
        const serverManagerJar = path.join(this.config.get('paths.plugins'), 'ServerManager-1.0-SNAPSHOT.jar');
        if (await fs.pathExists(serverManagerJar)) {
            await fs.copy(serverManagerJar, path.join(pluginsDir, 'ServerManager.jar'));
            this.logger.info('Copied ServerManager plugin to Velocity');
        }
        
        // Start Velocity
        const jarPath = path.resolve(jarConfig.path);
        const javaPath = this.config.getJavaPath(jarConfig.javaVersion);
        
        const args = [
            `-Xmx${jarConfig.maxMemory || '1G'}`,
            `-Xms${jarConfig.minMemory || '512M'}`,
            ...(jarConfig.flags || []),
            '-jar',
            jarPath
        ];
        
        const velocityProcess = spawn(javaPath, args, {
            cwd: proxyDir,
            shell: false
        });
        
        this.proxy = {
            type: proxyConfig.type,
            process: velocityProcess,
            pid: velocityProcess.pid,
            status: 'starting',
            port: proxyConfig.port,
            directory: proxyDir,
            console: [],
            startedAt: Date.now(),
            registeredServers: new Set()  // Track registered servers to avoid duplicates
        };
        
        // Handle console output
        velocityProcess.stdout.on('data', (data) => {
            const lines = data.toString().split('\n').filter(line => line.trim());
            for (const line of lines) {
                this.handleProxyConsoleOutput(line);
            }
        });
        
        velocityProcess.stderr.on('data', (data) => {
            const lines = data.toString().split('\n').filter(line => line.trim());
            for (const line of lines) {
                this.logger.error(`[Velocity Error] ${line}`);
                this.handleProxyConsoleOutput(`[ERROR] ${line}`);
            }
        });
        
        velocityProcess.on('exit', (code) => {
            this.logger.info(`Velocity proxy exited with code ${code}`);
            this.proxy = null;
            
            // Auto-restart if configured
            const proxyConfig = this.config.get('proxy');
            if (proxyConfig && proxyConfig.autoRestart && code !== 0) {
                setTimeout(() => {
                    this.logger.info('Auto-restarting Velocity proxy...');
                    this.startProxy().catch(err => {
                        this.logger.error(`Failed to restart proxy: ${err.message}`);
                    });
                }, 5000);
            }
        });
        
        // Wait for proxy to be ready before returning
        await new Promise((resolve) => {
            const checkReady = setInterval(() => {
                if (this.proxy && this.proxy.status === 'ready') {
                    clearInterval(checkReady);
                    resolve();
                }
            }, 100);
            
            // Timeout after 30 seconds
            setTimeout(() => {
                clearInterval(checkReady);
                resolve();
            }, 30000);
        });
        
        this.logger.info('Velocity proxy started successfully');
    }

    async createVelocityConfig(proxyDir, port) {
    const proxyConfig = this.config.get('proxy');
    const defaultServer = proxyConfig.defaultServer || 'hub';
    
    const velocityConfig = `# Velocity configuration
    config-version = "2.6"
    bind = "0.0.0.0:${port}"
    motd = "&3A Velocity Server"
    show-max-players = 500
    online-mode = false
    prevent-client-proxy-connections = false
    player-info-forwarding-mode = "legacy"
    forwarding-secret-file = "forwarding.secret"
    announce-forge = false

    [servers]
    # Hub server - will be updated dynamically when it starts
    ${defaultServer} = "127.0.0.1:25501"
    try = ["${defaultServer}"]

    [forced-hosts]
    # Add any forced hosts here

    [advanced]
    compression-threshold = 256
    compression-level = -1
    login-ratelimit = 3000
    connection-timeout = 5000
    read-timeout = 30000
    haproxy-protocol = false
    tcp-fast-open = false
    bungee-plugin-message-channel = true
    show-ping-requests = false
    failover-on-unexpected-server-disconnect = true
    announce-proxy-commands = true
    log-command-executions = false
    log-player-connections = true

    [query]
    enabled = false
    port = 25565
    map = "Velocity"
    show-plugins = false`;
        
        await fs.writeFile(path.join(proxyDir, 'velocity.toml'), velocityConfig);
    }

    // Optimized to prevent duplicate registrations
    async registerServerWithProxy(server) {
        if (!this.proxy || !server.port) return;
        
        const regKey = `${server.id}:${server.port}`;
        
        if (this.registeredWithProxy.has(regKey)) {
            this.logger.debug(`Server ${server.id} already registered with proxy`);
            return;
        }
        
        // Register with Redis (only once)
        await this.redis.publish('server:register', {
            id: server.id,
            host: '127.0.0.1',
            port: server.port,
            type: server.type || 'dynamic',
            game: server.gameType || server.metadata?.gameType || 'mini',
            status: server.status,
            metadata: server.metadata || {}
        });
        
        this.registeredWithProxy.add(regKey);
        this.logger.debug(`Registered ${server.id} with proxy on port ${server.port}`);
    }

    async stopDynamicServer(serverId) {
        const server = this.servers.get(serverId);
        if (!server) {
            this.logger.warn(`Server ${serverId} not found`);
            throw new Error(`Server ${serverId} not found`);  // Throw error so API knows it failed
        }

        this.logger.info(`Stopping dynamic server: ${serverId}`);
        
        // Unregister from proxy - FIX: stringify the JSON
        const regKey = `${server.id}:${server.port}`;
        if (this.registeredWithProxy.has(regKey)) {
            await this.redis.publish('server:unregister', JSON.stringify({  // FIX: JSON.stringify
                id: server.id,
                port: server.port
            }));
            this.registeredWithProxy.delete(regKey);
            this.logger.info(`Unregistered ${serverId} from proxy`);
        }
        
        // Stop the server process - FIX: pass the server ID, not the object
        await this.stopServer(serverId);  // FIX: Changed from stopServer(server)
        
        // Remove from tracking
        this.servers.delete(serverId);
        
        // Clean up directory with retry for Windows
        if (server.directory) {
            const maxRetries = 3;
            for (let i = 0; i < maxRetries; i++) {
                try {
                    await fs.remove(server.directory);
                    this.logger.debug(`Cleaned up directory for ${serverId}`);
                    break;
                } catch (err) {
                    if (i === maxRetries - 1) {
                        this.logger.warn(`Failed to clean directory for ${serverId}: ${err.message}`);
                    } else {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        }
        
        this.emit('dynamicServerStopped', serverId);
    }

    // When a server becomes ready, register it ONCE
    handleServerReady(server) {
        server.status = 'ready';
        this.logger.info(`Server ${server.id} is ready`);
        
        // Register with proxy only once
        this.registerServerWithProxy(server).catch(err => {
            this.logger.error(`Failed to register ${server.id} with proxy: ${err.message}`);
        });
        
        this.emit('serverReady', server);
    }

    handleProxyConsoleOutput(line) {
        if (!this.proxy) return;
        
        // Store in console buffer
        this.proxy.console.push({
            timestamp: Date.now(),
            line
        });
        
        // Trim console buffer
        if (this.proxy.console.length > 500) {
            this.proxy.console.shift();
        }
        
        // Emit console event
        this.emit('proxyConsole', {
            line
        });
        
        // Check for ready status
        if (line.includes('Done (') && line.includes('s)!')) {
            this.proxy.status = 'ready';
            this.logger.info('Velocity proxy is ready');
            this.emit('proxyReady');
        }
        
        // Log ALL messages for debugging
        this.logger.info(`[Velocity] ${line}`);

        // Log important messages
        if (line.includes('[INFO]')) {
            this.logger.debug(`[Velocity] ${line}`);
        }
    }

    async stopProxy() {
        if (!this.proxy || !this.proxy.process) {
            this.logger.warn('No proxy is running');
            return;
        }
        
        this.logger.info('Stopping Velocity proxy...');
        
        this.proxy.process.stdin.write('end\n');
        
        await new Promise(resolve => {
            let timeout = setTimeout(() => {
                if (this.proxy && this.proxy.process && !this.proxy.process.killed) {
                    this.logger.warn('Force killing Velocity proxy...');
                    this.proxy.process.kill('SIGKILL');
                }
                resolve();
            }, 10000);
            
            if (this.proxy && this.proxy.process) {
                this.proxy.process.once('exit', () => {
                    clearTimeout(timeout);
                    resolve();
                });
            } else {
                clearTimeout(timeout);
                resolve();
            }
        });
        
        this.proxy = null;
        this.logger.info('Velocity proxy stopped');
    }
    
    getProxyInfo() {
        if (!this.proxy) return null;
        
        return {
            type: this.proxy.type,
            status: this.proxy.status,
            port: this.proxy.port,
            pid: this.proxy.pid,
            uptime: Date.now() - this.proxy.startedAt
        };
    }
    
    getProxyConsole(lines = 100) {
        if (!this.proxy) return [];
        return this.proxy.console.slice(-lines);
    }
    
    async sendProxyCommand(command) {
        if (!this.proxy || !this.proxy.process) {
            throw new Error('Proxy not running');
        }
        
        this.proxy.process.stdin.write(command + '\n');
        this.logger.info(`Sent command to proxy: ${command}`);
    }

    // Generate random 5-character ID
    generateServerId(prefix = '') {
        const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
        let id = '';
        
        for (let i = 0; i < 5; i++) {
            id += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        
        const fullId = prefix ? `${prefix}-${id}` : id;
        
        // Ensure uniqueness
        if (this.servers.has(fullId) || this.staticServers.has(fullId)) {
            return this.generateServerId(prefix); // Recursive call for new ID
        }
        
        return fullId;
    }

    // Single method for creating ALL dynamic servers
    async createDynamicServer(options = {}) {
        const {
            gameType = 'mini',
            jar = null,
            configTemplate = null,
            plugins = [],
            worldType = 'void',
            maxPlayers = 16,
            metadata = {}
        } = options;
        
        // Get template configuration
        const template = this.config.getGameTemplate(gameType);
        if (!template && !jar) {
            throw new Error(`Template not found and no jar specified: ${gameType}`);
        }
        
        // Generate unique server ID with game type prefix
        const serverId = this.generateServerId(gameType);
        
        // Get an available port
        const port = await this.getAvailablePort();
        
        this.logger.info(`Creating dynamic server: ${serverId} on port ${port}`);
        
        try {
            // Clean up old directory if it exists (Windows file lock issue)
            const serverDir = this.getServerDirectory(serverId, 'dynamic');
            if (await fs.pathExists(serverDir)) {
                try {
                    await fs.remove(serverDir);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (err) {
                    this.logger.warn(`Could not clean old directory for ${serverId}: ${err.message}`);
                }
            }
            
            // Create the server
            const server = await this.createServer({
                id: serverId,
                type: 'dynamic',
                gameType,
                port,
                jar: jar || template?.jar || 'paper-1.8.8',
                configTemplate: configTemplate || template?.configTemplate || template?.template || 'game',
                plugins: plugins.length > 0 ? plugins : (template?.plugins || []),
                worldType: worldType || template?.worldType || 'void',
                maxPlayers: maxPlayers || template?.maxPlayers || 16,
                metadata: {
                    ...metadata,
                    createdAt: Date.now(),
                    gameType
                }
            });
            
            // Add to servers map
            this.servers.set(serverId, server);
            
            // Start the server
            await this.startServer(server);
            
            // Register with proxy (only once)
            if (this.proxy && server.status === 'ready') {
                await this.registerServerWithProxy(server);
            }
            
            this.emit('dynamicServerCreated', server);
            
            return server;
            
        } catch (error) {
            this.logger.error(`Failed to create dynamic server ${serverId}: ${error.message}`);
            // Clean up on failure
            this.servers.delete(serverId);
            if (port) this.releasePort(port);
            throw error;
        }
    }

    // Simple port management
    async getAvailablePort() {
        const startPort = this.config.get('ports.rangeStart', 25600);
        const endPort = this.config.get('ports.rangeEnd', 25700);
        
        const usedPorts = new Set();
        
        // Collect all used ports
        this.servers.forEach(server => {
            if (server.port) usedPorts.add(server.port);
        });
        
        this.staticServers.forEach(server => {
            if (server.port) usedPorts.add(server.port);
        });
        
        // Add hub port if configured
        const hubPort = this.config.get('servers.hub.port');
        if (hubPort) usedPorts.add(hubPort);
        
        // Find first available port
        for (let port = startPort; port <= endPort; port++) {
            if (!usedPorts.has(port)) {
                return port;
            }
        }
        
        throw new Error(`No available ports in range ${startPort}-${endPort}`);
    }

    releasePort(port) {
        // Port is automatically released when server is removed from maps
        this.logger.debug(`Released port ${port}`);
    }

    // Get all dynamic servers
    getDynamicServers() {
        const servers = [];
        this.servers.forEach((server, id) => {
            servers.push({
                id,
                port: server.port,
                status: server.status,
                gameType: server.gameType || server.metadata?.gameType,
                players: server.players?.length || 0,
                maxPlayers: server.maxPlayers,
                uptime: server.startedAt ? Date.now() - server.startedAt : 0,
                metadata: server.metadata
            });
        });
        return servers;
    }

    // Get server by ID
    getServer(serverId) {
        return this.servers.get(serverId) || this.staticServers.get(serverId);
    }


}

module.exports = ServerController;