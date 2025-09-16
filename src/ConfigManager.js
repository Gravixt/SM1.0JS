// src/ConfigManager.js - Complete Configuration Management Module

const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const EventEmitter = require('events');
const Logger = require('./utils/Logger');

class ConfigManager extends EventEmitter {
    constructor(configPath = 'config.json') {
        super();
        this.configPath = configPath;
        this.config = null;
        this.templates = new Map();
        this.dynamicConfigs = new Map();
        this.logger = new Logger('ConfigManager');
    }

    async load() {
        try {
            this.config = await fs.readJSON(this.configPath);
            await this.loadTemplates();
            this.logger.info('Configuration loaded successfully');
            this.emit('loaded', this.config);
            return this.config;
        } catch (error) {
            this.logger.warn('No config file found, using defaults');
            this.config = this.getDefaultConfig();
            await this.save();
            return this.config;
        }
    }

    async save() {
        await fs.writeJSON(this.configPath, this.config, { spaces: 2 });
        this.logger.info('Configuration saved');
        this.emit('saved', this.config);
    }

    async loadTemplates() {
        const templatesDir = this.config.paths?.configs || './templates/configs';
        
        if (!await fs.pathExists(templatesDir)) {
            this.logger.warn('Templates directory not found');
            return;
        }

        const templates = await fs.readdir(templatesDir);
        
        for (const template of templates) {
            const templatePath = path.join(templatesDir, template);
            const stat = await fs.stat(templatePath);
            
            if (stat.isDirectory()) {
                const config = await this.loadTemplateConfig(templatePath);
                this.templates.set(template, config);
                this.logger.debug(`Loaded template: ${template}`);
            }
        }
    }

    async loadTemplateConfig(templatePath) {
        const config = {
            path: templatePath,
            files: {}
        };

        const files = await fs.readdir(templatePath);
        
        for (const file of files) {
            const filePath = path.join(templatePath, file);
            const stat = await fs.stat(filePath);
            
            if (!stat.isDirectory()) {
                const content = await fs.readFile(filePath, 'utf8');
                config.files[file] = content;
            }
        }

        return config;
    }

    async generateServerConfig(serverId, options = {}) {
        const {
            template = 'minimal',
            gameType = null,
            plugins = [],
            settings = {},
            port = null
        } = options;

        this.logger.info(`Generating config for ${serverId} with template ${template}`);

        // Get base template
        const baseTemplate = this.templates.get(template) || this.templates.get('minimal');
        
        if (!baseTemplate) {
            // Create a minimal template if none exists
            return this.createMinimalConfig(serverId, port, settings);
        }

        // Clone template files
        const config = JSON.parse(JSON.stringify(baseTemplate.files));

        // Apply port if specified
        if (port && config['server.properties']) {
            config['server.properties'] = config['server.properties'].replace(
                /server-port=\d+/,
                `server-port=${port}`
            );
        }

        // Apply custom settings
        if (settings && config['server.properties']) {
            for (const [key, value] of Object.entries(settings)) {
                const regex = new RegExp(`${key}=.*`, 'g');
                if (config['server.properties'].match(regex)) {
                    config['server.properties'] = config['server.properties'].replace(
                        regex,
                        `${key}=${value}`
                    );
                } else {
                    config['server.properties'] += `\n${key}=${value}`;
                }
            }
        }

        return config;
    }

    createMinimalConfig(serverId, port = 25565, settings = {}) {
        const serverProperties = `
server-port=${port}
online-mode=false
spawn-protection=0
max-players=${settings['max-players'] || 20}
motd=${settings.motd || serverId}
gamemode=${settings.gamemode || 'survival'}
difficulty=${settings.difficulty || 'normal'}
pvp=${settings.pvp !== undefined ? settings.pvp : true}
level-type=${settings['level-type'] || 'DEFAULT'}
`.trim();

        return {
            'server.properties': serverProperties,
            'eula.txt': 'eula=true'
        };
    }

    async writeServerConfig(serverDir, config) {
        await fs.ensureDir(serverDir);
        
        for (const [file, content] of Object.entries(config)) {
            const filePath = path.join(serverDir, file);
            
            if (typeof content === 'object' && (file.endsWith('.yml') || file.endsWith('.yaml'))) {
                await fs.writeFile(filePath, yaml.dump(content));
            } else if (typeof content === 'object') {
                await fs.writeFile(filePath, JSON.stringify(content, null, 2));
            } else {
                await fs.writeFile(filePath, content);
            }
        }
        
        // Always ensure eula.txt exists
        const eulaPath = path.join(serverDir, 'eula.txt');
        if (!await fs.pathExists(eulaPath)) {
            await fs.writeFile(eulaPath, 'eula=true');
        }
    }

    // CRITICAL: These are the methods that ServerController needs
    
    getJarConfig(jarName) {
        // Check if jars config exists
        if (!this.config?.jars) {
            this.logger.error(`No jars configuration found`);
            return null;
        }
        
        const jarConfig = this.config.jars[jarName];
        if (!jarConfig) {
            this.logger.error(`JAR configuration not found for: ${jarName}`);
        }
        return jarConfig;
    }

    getStaticServerConfig(name) {
        // Check new structure first
        if (name === 'hub' && this.config?.servers?.hub) {
            return this.config.servers.hub;
        }
        
        // Check static array
        if (this.config?.servers?.static) {
            const staticServer = this.config.servers.static.find(s => s.id === name);
            if (staticServer) return staticServer;
        }
        
        // Fallback to old structure
        if (this.config?.staticServers) {
            return this.config.staticServers[name];
        }
        
        return null;
    }

    getGameTemplate(gameType) {
        // Check new structure: servers.dynamic.templates
        if (this.config?.servers?.dynamic?.templates?.[gameType]) {
            return this.config.servers.dynamic.templates[gameType];
        }
        
        // Fallback to old structure
        if (this.config?.gameTemplates?.[gameType]) {
            return this.config.gameTemplates[gameType];
        }
        
        return null;
    }

    getJavaPath(version) {
        // Support both 'java' and 'javaPaths' in config
        const paths = this.config?.java || this.config?.javaPaths || {};
        const javaPath = paths[version] || paths[17] || paths[8] || 'java';
        
        this.logger.debug(`Using Java path for version ${version}: ${javaPath}`);
        return javaPath;
    }

    get(path, defaultValue = null) {
        if (!this.config) {
            return defaultValue;
        }
        
        const keys = path.split('.');
        let value = this.config;
        
        for (const key of keys) {
            if (value && typeof value === 'object' && key in value) {
                value = value[key];
            } else {
                return defaultValue;
            }
        }
        
        return value;
    }

    set(path, value) {
        if (!this.config) {
            this.config = {};
        }
        
        const keys = path.split('.');
        let target = this.config;
        
        for (let i = 0; i < keys.length - 1; i++) {
            if (!target[keys[i]]) {
                target[keys[i]] = {};
            }
            target = target[keys[i]];
        }
        
        target[keys[keys.length - 1]] = value;
        this.emit('changed', { path, value });
    }

    getDefaultConfig() {
        return {
            serverManager: {
                version: "2.0.0",
                environment: "production"
            },
            jars: {
                "paper-1.8.8": {
                    path: "templates/server-jars/paper-1.8.8-445.jar",
                    javaVersion: 8,
                    minMemory: "512M",
                    maxMemory: "2G",
                    flags: ["-XX:+UseG1GC"]
                },
                "velocity": {
                    path: "templates/server-jars/velocity-3.3.0.jar",
                    javaVersion: 17,
                    minMemory: "512M",
                    maxMemory: "1G"
                }
            },
            java: {
                8: "java",
                17: "java"
            },
            paths: {
                templates: "./templates",
                configs: "./templates/configs",
                plugins: "./templates/plugins",
                servers: "./servers",
                logs: "./logs"
            },
            proxy: {
                enabled: true,
                type: "velocity",
                jar: "velocity",
                port: 25565,
                directory: "./servers/velocity",
                defaultServer: "hub"
            },
            servers: {
                hub: {
                    enabled: true,
                    id: "hub",
                    port: 25501,
                    jar: "paper-1.8.8"
                },
                static: [],
                dynamic: {
                    templates: {
                        mini: {
                            jar: "paper-1.8.8",
                            template: "game"
                        }
                    }
                }
            },
            pool: {
                enabled: true,
                minServers: 2,
                maxServers: 10,
                template: "mini"
            },
            ports: {
                rangeStart: 25600,
                rangeEnd: 25700,
                apiPort: 3000
            },
            redis: {
                host: "localhost",
                port: 6379
            }
        };
    }
}

module.exports = ConfigManager;