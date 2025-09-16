#!/usr/bin/env node

// setup.js - Interactive setup utility for Minecraft Server Manager v2.0
const fs = require('fs-extra');
const path = require('path');
const { execSync } = require('child_process');

// Handle dependencies that might not be installed yet
let chalk, prompts;
try {
    chalk = require('chalk');
    prompts = require('prompts');
} catch (e) {
    // Dependencies not installed yet - will install them first
}

class ServerManagerSetup {
    constructor() {
        this.baseDir = process.cwd();
        this.config = {};
        this.javaPaths = {};
        this.chalk = chalk;
        this.prompts = prompts;
    }

    async run() {
        try {
            // Install basic dependencies first if needed
            if (!chalk || !prompts) {
                await this.installBasicDependencies();
            }
            
            console.clear();
            this.printHeader();
            
            // Check prerequisites
            await this.checkPrerequisites();
            
            // Create directory structure
            await this.createDirectoryStructure();
            
            // Install dependencies
            await this.installDependencies();
            
            // Configure server manager
            await this.configureManager();
            
            // Download server JARs
            await this.downloadServerJars();
            
            // Setup templates
            await this.setupTemplates();
            
            // Create source file placeholders
            await this.createSourceFiles();
            
            // Setup systemd service
            await this.setupSystemd();
            
            // Print next steps
            this.printNextSteps();
            
        } catch (error) {
            this.log(`\n❌ Setup failed: ${error.message}`, 'error');
            if (error.stack) {
                console.error(this.chalk ? this.chalk.gray(error.stack) : error.stack);
            }
            process.exit(1);
        }
    }

    async installBasicDependencies() {
        console.log('📦 Installing basic dependencies needed for setup...');
        
        // Create minimal package.json if it doesn't exist
        if (!fs.existsSync('package.json')) {
            const minimalPackage = {
                name: 'minecraft-server-manager',
                version: '2.0.0',
                dependencies: {}
            };
            fs.writeFileSync('package.json', JSON.stringify(minimalPackage, null, 2));
        }
        
        try {
            console.log('  Installing chalk, prompts, and fs-extra...');
            execSync('npm install chalk@4.1.2 prompts@2.4.2 fs-extra@11.1.0', { 
                stdio: 'inherit',
                cwd: this.baseDir 
            });
            
            // Clear require cache and reload modules
            delete require.cache[require.resolve('chalk')];
            delete require.cache[require.resolve('prompts')];
            
            chalk = require('chalk');
            prompts = require('prompts');
            this.chalk = chalk;
            this.prompts = prompts;
            
            console.log('  ✓ Basic dependencies installed\n');
        } catch (error) {
            console.error('Failed to install basic dependencies:', error.message);
            console.log('\nPlease run: npm install chalk prompts fs-extra');
            console.log('Then run: node setup.js');
            process.exit(1);
        }
    }

    printHeader() {
        if (this.chalk) {
            console.log(this.chalk.cyan('╔════════════════════════════════════════════════╗'));
            console.log(this.chalk.cyan('║                                                ║'));
            console.log(this.chalk.cyan('║    ') + this.chalk.bold.white('Minecraft Server Manager Setup v2.0') + this.chalk.cyan('      ║'));
            console.log(this.chalk.cyan('║    ') + this.chalk.gray('Plugin-Driven Dynamic Architecture') + this.chalk.cyan('       ║'));
            console.log(this.chalk.cyan('║                                                ║'));
            console.log(this.chalk.cyan('╚════════════════════════════════════════════════╝'));
        } else {
            console.log('╔════════════════════════════════════════════════╗');
            console.log('║                                                ║');
            console.log('║    Minecraft Server Manager Setup v2.0        ║');
            console.log('║    Plugin-Driven Dynamic Architecture          ║');
            console.log('║                                                ║');
            console.log('╚════════════════════════════════════════════════╝');
        }
        console.log();
    }

    log(message, type = 'info') {
        if (this.chalk) {
            const prefix = {
                info: this.chalk.blue('ℹ'),
                success: this.chalk.green('✓'),
                warning: this.chalk.yellow('⚠'),
                error: this.chalk.red('✗'),
                header: this.chalk.cyan('▶')
            };

            console.log(`${prefix[type] || ''} ${message}`);
        } else {
            // Fallback without colors
            const prefix = {
                info: 'ℹ',
                success: '✓',
                warning: '⚠',
                error: '✗',
                header: '▶'
            };

            console.log(`${prefix[type] || ''} ${message}`);
        }
    }

    async checkPrerequisites() {
        this.log('Checking prerequisites...', 'header');
        
        // Check Node.js version
        const nodeVersion = process.version;
        const major = parseInt(nodeVersion.split('.')[0].substring(1));
        if (major < 16) {
            throw new Error(`Node.js 16+ required (current: ${nodeVersion})`);
        }
        this.log(`  ✓ Node.js ${nodeVersion}`, 'info');
        
        // Detect Java installations
        await this.detectJavaInstallations();
        
        if (Object.keys(this.javaPaths).length === 0) {
            throw new Error('No Java installations found. Please install Java 8 and/or Java 17.');
        }
        
        // Check Redis
        try {
            execSync('redis-cli ping', { stdio: 'pipe' });
            this.log('  ✓ Redis is available', 'success');
            this.redisAvailable = true;
        } catch (error) {
            this.log('  ⚠ Redis not available (optional but recommended)', 'warning');
            this.redisAvailable = false;
        }
    }

    async detectJavaInstallations() {
        this.log('  Detecting Java installations...', 'info');
        
        // Windows-specific paths based on common installations
        const windowsJavaPaths = [
            'C:\\Program Files\\Java\\jdk1.8.0_202\\bin\\java.exe',
            'C:\\Program Files\\Java\\jdk1.8.0_*\\bin\\java.exe',
            'C:\\Program Files\\Java\\jre1.8.0_*\\bin\\java.exe',
            'C:\\Program Files (x86)\\Java\\jre1.8.0_*\\bin\\java.exe',
            'C:\\Program Files\\Java\\jdk-8\\bin\\java.exe',
            'C:\\Program Files\\Java\\jdk-11\\bin\\java.exe',
            'C:\\Program Files\\Java\\jdk-17\\bin\\java.exe',
            'C:\\Program Files\\Java\\jdk-21\\bin\\java.exe',
            'C:\\Program Files\\Java\\jdk-23\\bin\\java.exe',
            'C:\\Program Files\\Eclipse Adoptium\\jdk-8*\\bin\\java.exe',
            'C:\\Program Files\\Eclipse Adoptium\\jdk-11*\\bin\\java.exe',
            'C:\\Program Files\\Eclipse Adoptium\\jdk-17*\\bin\\java.exe',
            'C:\\Program Files\\Eclipse Adoptium\\temurin-8*\\bin\\java.exe',
            'C:\\Program Files\\Eclipse Adoptium\\temurin-17*\\bin\\java.exe',
            'C:\\Program Files\\Amazon Corretto\\jdk*\\bin\\java.exe',
            'C:\\Program Files\\Zulu\\zulu-8\\bin\\java.exe',
            'C:\\Program Files\\Zulu\\zulu-17\\bin\\java.exe'
        ];
        
        // Linux/Unix paths
        const unixJavaPaths = [
            '/usr/lib/jvm/java-8-openjdk/bin/java',
            '/usr/lib/jvm/java-8-openjdk-amd64/bin/java',
            '/usr/lib/jvm/java-11-openjdk/bin/java',
            '/usr/lib/jvm/java-11-openjdk-amd64/bin/java',
            '/usr/lib/jvm/java-17-openjdk/bin/java',
            '/usr/lib/jvm/java-17-openjdk-amd64/bin/java',
            '/usr/lib/jvm/adoptopenjdk-8-hotspot/bin/java',
            '/usr/lib/jvm/adoptopenjdk-17-hotspot/bin/java',
            '/usr/lib/jvm/temurin-8-jdk/bin/java',
            '/usr/lib/jvm/temurin-17-jdk/bin/java'
        ];
        
        // Mac paths
        const macJavaPaths = [
            '/Library/Java/JavaVirtualMachines/temurin-8.jdk/Contents/Home/bin/java',
            '/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home/bin/java',
            '/Library/Java/JavaVirtualMachines/jdk1.8.0_*.jdk/Contents/Home/bin/java',
            '/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home/bin/java'
        ];
        
        // Combine paths based on platform
        let pathsToCheck = ['java']; // Always check PATH first
        
        if (process.platform === 'win32') {
            // Expand wildcards for Windows
            for (const pattern of windowsJavaPaths) {
                if (pattern.includes('*')) {
                    const dir = path.dirname(pattern);
                    const filePattern = path.basename(pattern);
                    
                    if (fs.existsSync(path.dirname(dir))) {
                        try {
                            const parentDirs = fs.readdirSync(path.dirname(dir));
                            for (const parentDir of parentDirs) {
                                const fullPath = path.join(path.dirname(dir), parentDir, 'bin', 'java.exe');
                                if (fs.existsSync(fullPath)) {
                                    pathsToCheck.push(fullPath);
                                }
                            }
                        } catch (e) {
                            // Skip if can't read directory
                        }
                    }
                } else {
                    pathsToCheck.push(pattern);
                }
            }
        } else if (process.platform === 'darwin') {
            pathsToCheck.push(...macJavaPaths);
        } else {
            pathsToCheck.push(...unixJavaPaths);
        }
        
        // Also check JAVA_HOME
        if (process.env.JAVA_HOME) {
            const javaExe = process.platform === 'win32' ? 'java.exe' : 'java';
            pathsToCheck.push(path.join(process.env.JAVA_HOME, 'bin', javaExe));
        }
        
        // Test each path and detect version
        for (const javaPath of pathsToCheck) {
            if (javaPath.includes('*')) continue; // Skip patterns
            
            try {
                if (!fs.existsSync(javaPath) && javaPath !== 'java') continue;
                
                const output = execSync(`"${javaPath}" -version 2>&1`, { 
                    encoding: 'utf8',
                    stdio: 'pipe'
                });
                
                const versionMatch = output.match(/version "(\d+)(?:\.(\d+))?/);
                if (versionMatch) {
                    const majorVersion = versionMatch[1] === '1' ? versionMatch[2] : versionMatch[1];
                    
                    // Only keep the best path for each version
                    if (!this.javaPaths[majorVersion]) {
                        this.javaPaths[majorVersion] = javaPath;
                        this.log(`    ✓ Java ${majorVersion}: ${javaPath}`, 'success');
                    }
                }
            } catch (e) {
                // Can't execute this Java, skip it
            }
        }
        
        // Report missing Java versions
        if (!this.javaPaths['8']) {
            this.log('    ⚠ Java 8 not found (required for Paper 1.8.8)', 'warning');
            this.log('      Download from: https://adoptium.net/temurin/releases/?version=8', 'info');
        }
        if (!this.javaPaths['17'] && !this.javaPaths['21']) {
            this.log('    ⚠ Java 17/21 not found (required for Velocity and Paper 1.20+)', 'warning');
            this.log('      Download from: https://adoptium.net/temurin/releases/?version=17', 'info');
        }
    }

    async testJavaVersion(javaPath, expectedVersion = null) {
        try {
            const output = execSync(`"${javaPath}" -version 2>&1`, { 
                encoding: 'utf8',
                stdio: 'pipe'
            });
            
            const versionMatch = output.match(/version "(\d+)(?:\.(\d+))?/);
            if (versionMatch) {
                const majorVersion = versionMatch[1] === '1' ? versionMatch[2] : versionMatch[1];
                
                if (!expectedVersion || parseInt(majorVersion) === expectedVersion) {
                    this.javaPaths[majorVersion] = javaPath;
                    return true;
                }
            }
        } catch (e) {
            // Java path doesn't work
        }
        return false;
    }

    async createDirectoryStructure() {
        this.log('\n📁 Creating directory structure...', 'header');
        
        const directories = [
            // Core directories
            'src',
            'src/utils',
            'api',
            'api/routes',
            'api/websocket',
            
            // Template directories
            'templates',
            'templates/configs',
            'templates/configs/minimal',
            'templates/configs/hub',
            'templates/configs/game',
            'templates/configs/velocity',
            'templates/configs/limbo',
            'templates/configs/void',
            'templates/configs/creative',
            
            // Plugin directories by type
            'templates/plugins',
            'templates/plugins/core',
            'templates/plugins/hub',
            'templates/plugins/minigame',
            'templates/plugins/bedwars',
            'templates/plugins/sumo',
            'templates/plugins/bridge',
            'templates/plugins/worldedit',
            
            // Server JARs
            'templates/server-jars',
            
            // Server directories
            'servers',
            'servers/static',
            'servers/dynamic',
            'servers/velocity',
            
            // Other directories
            'public',
            'logs',
            'data',
            'backups'
        ];
        
        for (const dir of directories) {
            await fs.ensureDir(path.join(this.baseDir, dir));
            this.log(`  ✓ ${dir}`, 'info');
        }
    }

    async installDependencies() {
        this.log('\n📦 Installing dependencies...', 'header');
        
        const packageJson = {
            name: 'minecraft-server-manager',
            version: '2.0.0',
            description: 'Dynamic Minecraft Server Manager with Plugin-Driven Configuration',
            main: 'src/ServerManager.js',
            scripts: {
                start: 'node src/ServerManager.js',
                setup: 'node setup.js',
                dev: 'nodemon src/ServerManager.js',
                dashboard: 'node api/ApiServer.js',
                test: 'jest'
            },
            dependencies: {
                express: '^4.18.2',
                'socket.io': '^4.5.4',
                redis: '^4.5.1',
                'fs-extra': '^11.1.0',
                axios: '^1.2.0',
                chalk: '^4.1.2',
                prompts: '^2.4.2',
                winston: '^3.8.2',
                'node-cron': '^3.0.2',
                uuid: '^9.0.0',
                'js-yaml': '^4.1.0'
            },
            devDependencies: {
                nodemon: '^2.0.20',
                jest: '^29.3.1'
            }
        };
        
        await fs.writeJSON(path.join(this.baseDir, 'package.json'), packageJson, { spaces: 2 });
        
        this.log('  Installing npm packages...', 'info');
        execSync('npm install', { stdio: 'inherit' });
        this.log('  ✓ Dependencies installed', 'success');
    }

    async configureManager() {
        this.log('\n⚙️  Configuring server manager...', 'header');
        
        // Check if there's an existing config to merge
        const existingConfigPath = path.join(this.baseDir, 'config.json');
        let existingConfig = null;
        
        if (await fs.pathExists(existingConfigPath)) {
            try {
                existingConfig = await fs.readJSON(existingConfigPath);
                this.log('  Found existing config.json to merge', 'info');
            } catch (e) {
                this.log('  Could not read existing config.json', 'warning');
            }
        }
        
        const questions = [
            {
                type: 'number',
                name: 'apiPort',
                message: 'API server port:',
                initial: existingConfig?.ports?.apiPort || 3000
            },
            {
                type: 'number',
                name: 'velocityPort',
                message: 'Velocity proxy port:',
                initial: existingConfig?.proxy?.port || 25565
            },
            {
                type: 'confirm',
                name: 'enableVelocity',
                message: 'Enable Velocity proxy?',
                initial: existingConfig?.proxy?.enabled ?? true
            },
            {
                type: 'confirm',
                name: 'enableHub',
                message: 'Enable hub server?',
                initial: existingConfig?.servers?.hub?.enabled ?? true
            },
            {
                type: 'number',
                name: 'hubPort',
                message: 'Hub server port:',
                initial: existingConfig?.servers?.hub?.port || 25501
            },
            {
                type: 'confirm',
                name: 'enableLimbo',
                message: 'Enable limbo fallback server?',
                initial: existingConfig?.servers?.static?.[0]?.enabled ?? false
            },
            {
                type: 'select',
                name: 'defaultGameTemplate',
                message: 'Default game template:',
                choices: [
                    { title: 'Mini (Basic Minigame)', value: 'mini' },
                    { title: 'Bedwars', value: 'bedwars' },
                    { title: 'Sumo', value: 'sumo' },
                    { title: 'Bridge', value: 'bridge' },
                    { title: 'Creative', value: 'creative' }
                ],
                initial: 0
            },
            {
                type: 'confirm',
                name: 'enablePool',
                message: 'Enable warm server pool?',
                initial: existingConfig?.pool?.enabled ?? true
            },
            {
                type: 'number',
                name: 'minPool',
                message: 'Minimum pool size:',
                initial: existingConfig?.pool?.minServers || 2
            },
            {
                type: 'number',
                name: 'maxPool',
                message: 'Maximum pool size:',
                initial: existingConfig?.pool?.maxServers || 5
            },
            {
                type: 'number',
                name: 'maxDynamicServers',
                message: 'Maximum total dynamic servers:',
                initial: existingConfig?.servers?.dynamic?.maxServers || 20
            },
            {
                type: 'number',
                name: 'dynamicPortStart',
                message: 'Dynamic servers port range start:',
                initial: existingConfig?.ports?.rangeStart || 25600
            },
            {
                type: 'number',
                name: 'dynamicPortEnd',
                message: 'Dynamic servers port range end:',
                initial: existingConfig?.ports?.rangeEnd || 25700
            },
            {
                type: 'confirm',
                name: 'enableRedis',
                message: 'Enable Redis for plugin communication?',
                initial: existingConfig?.redis?.enabled ?? this.redisAvailable
            }
        ];
        
        const answers = await prompts(questions);
        
        // Generate secure API key (or keep existing)
        const apiKey = existingConfig?.security?.apiKey || this.generateApiKey();
        
        // Build comprehensive config merging with existing values
        this.config = {
            serverManager: {
                version: '2.0.0',
                environment: existingConfig?.serverManager?.environment || 'production'
            },
            jars: existingConfig?.jars || {
                'paper-1.8.8': {
                    path: 'templates/server-jars/paper-1.8.8-445.jar',
                    url: 'https://api.papermc.io/v2/projects/paper/versions/1.8.8/builds/445/downloads/paper-1.8.8-445.jar',
                    javaVersion: 8,
                    minMemory: '512M',
                    maxMemory: '2G',
                    flags: [
                        '-XX:+UseG1GC',
                        '-XX:G1HeapRegionSize=4M',
                        '-XX:+UnlockExperimentalVMOptions',
                        '-XX:+ParallelRefProcEnabled',
                        '-XX:+AlwaysPreTouch',
                        '-XX:MaxGCPauseMillis=200',
                        '-XX:+DisableExplicitGC',
                        '-XX:G1MixedGCCountTarget=4',
                        '-XX:G1MixedGCLiveThresholdPercent=90',
                        '-XX:G1RSetUpdatingPauseTimePercent=5',
                        '-XX:SurvivorRatio=32',
                        '-XX:+PerfDisableSharedMem',
                        '-XX:MaxTenuringThreshold=1',
                        '-Dusing.aikars.flags=https://mcflags.emc.gs',
                        '-Daikars.new.flags=true'
                    ]
                },
                'paper-1.20.4': {
                    path: 'templates/server-jars/paper-1.20.4-496.jar',
                    url: 'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/496/downloads/paper-1.20.4-496.jar',
                    javaVersion: 17,
                    minMemory: '1G',
                    maxMemory: '4G',
                    flags: [
                        '-XX:+UseG1GC',
                        '-XX:G1HeapRegionSize=4M',
                        '-XX:+UnlockExperimentalVMOptions',
                        '-XX:+ParallelRefProcEnabled',
                        '-XX:+AlwaysPreTouch',
                        '-XX:MaxGCPauseMillis=200',
                        '-XX:+DisableExplicitGC',
                        '-XX:G1MixedGCCountTarget=4',
                        '-XX:G1MixedGCLiveThresholdPercent=90',
                        '-XX:G1RSetUpdatingPauseTimePercent=5',
                        '-XX:SurvivorRatio=32',
                        '-XX:+PerfDisableSharedMem',
                        '-XX:MaxTenuringThreshold=1',
                        '-Dusing.aikars.flags=https://mcflags.emc.gs',
                        '-Daikars.new.flags=true'
                    ]
                },
                'velocity': {
                    path: 'templates/server-jars/velocity-3.3.0.jar',
                    url: 'https://api.papermc.io/v2/projects/velocity/versions/3.3.0-SNAPSHOT/builds/365/downloads/velocity-3.3.0-SNAPSHOT-365.jar',
                    javaVersion: 17,
                    minMemory: '512M',
                    maxMemory: '1G',
                    flags: [
                        '-XX:+UseG1GC',
                        '-XX:G1HeapRegionSize=4M',
                        '-XX:+UnlockExperimentalVMOptions',
                        '-XX:+ParallelRefProcEnabled',
                        '-XX:+AlwaysPreTouch'
                    ]
                }
            },
            java: this.javaPaths,
            paths: {
                templates: './templates',
                configs: './templates/configs',
                plugins: './templates/plugins',
                servers: './servers',
                worlds: './templates/worlds',
                logs: './logs',
                data: './data',
                backups: './backups'
            },
            proxy: {
                enabled: answers.enableVelocity,
                type: 'velocity',
                jar: 'velocity',
                host: '0.0.0.0',
                port: answers.velocityPort,
                directory: './servers/velocity',
                defaultServer: 'hub',
                fallbackServers: answers.enableLimbo ? ['hub', 'limbo'] : ['hub'],
                autoStart: true,
                autoRestart: true,
                configTemplate: 'velocity',
                motd: existingConfig?.proxy?.motd || '&3&lMinecraft Network &7| &fPowered by ServerManager',
                plugins: ['servermanager']
            },
            servers: {
                hub: answers.enableHub ? {
                    enabled: true,
                    id: 'hub',
                    type: 'static',
                    port: answers.hubPort,
                    jar: 'paper-1.8.8',
                    template: 'hub',
                    configTemplate: 'hub',
                    autoStart: true,
                    maxPlayers: 100,
                    plugins: ['core', 'hub'],
                    description: 'Main Hub Server'
                } : null,
                static: answers.enableLimbo ? [{
                    enabled: true,
                    id: 'limbo',
                    type: 'static',
                    port: 25599,
                    jar: 'paper-1.8.8',
                    template: 'limbo',
                    configTemplate: 'limbo',
                    autoStart: false,
                    maxPlayers: 50,
                    plugins: ['core'],
                    description: 'Fallback Limbo Server'
                }] : [],
                dynamic: {
                    enabled: true,
                    startPort: existingConfig?.servers?.dynamic?.startPort || 25601,
                    maxServers: answers.maxDynamicServers,
                    defaultTemplate: answers.defaultGameTemplate || 'mini',
                    shutdownEmpty: true,
                    emptyTimeout: 300000,
                    requestTimeout: 5000,
                    healthCheckInterval: 10000,
                    templates: existingConfig?.servers?.dynamic?.templates || {
                        mini: {
                            jar: 'paper-1.8.8',
                            template: 'game',
                            configTemplate: 'game',
                            maxPlayers: 16,
                            plugins: ['core', 'minigame'],
                            worldType: 'void',
                            minMemory: '512M',
                            maxMemory: '1G',
                            gameConfig: {
                                minPlayers: 2,
                                maxPlayers: 16,
                                startCountdown: 10,
                                gameTime: 600
                            }
                        },
                        bedwars: {
                            jar: 'paper-1.8.8',
                            template: 'game',
                            configTemplate: 'game',
                            maxPlayers: 16,
                            plugins: ['core', 'minigame', 'bedwars'],
                            worldType: 'void',
                            minMemory: '512M',
                            maxMemory: '1G',
                            gameConfig: {
                                minPlayers: 2,
                                maxPlayers: 16,
                                teams: 4,
                                startCountdown: 20,
                                respawnTime: 5
                            }
                        },
                        sumo: {
                            jar: 'paper-1.8.8',
                            template: 'game',
                            configTemplate: 'game',
                            maxPlayers: 8,
                            plugins: ['core', 'minigame', 'sumo'],
                            worldType: 'void',
                            minMemory: '512M',
                            maxMemory: '1G',
                            gameConfig: {
                                minPlayers: 2,
                                maxPlayers: 8,
                                rounds: 3,
                                roundTime: 120
                            }
                        },
                        creative: {
                            jar: 'paper-1.20.4',
                            template: 'creative',
                            configTemplate: 'creative',
                            maxPlayers: 20,
                            plugins: ['core', 'worldedit'],
                            worldType: 'flat',
                            minMemory: '1G',
                            maxMemory: '2G'
                        }
                    }
                }
            },
            pool: {
                enabled: answers.enablePool,
                minServers: answers.minPool,
                maxServers: answers.maxPool,
                minWarm: answers.minPool,
                maxWarm: answers.maxPool,
                template: answers.defaultGameTemplate || 'mini',
                warmupTime: existingConfig?.pool?.warmupTime || 45000,
                idleTimeout: 300000,
                scaleUpThreshold: 0.8,
                scaleDownThreshold: 0.3,
                checkInterval: 30000,
                scaleCheckInterval: 30000
            },
            ports: {
                rangeStart: answers.dynamicPortStart,
                rangeEnd: answers.dynamicPortEnd,
                apiPort: answers.apiPort,
                velocityPort: answers.velocityPort
            },
            redis: {
                enabled: answers.enableRedis,
                host: 'localhost',
                port: 6379,
                password: '',
                db: 0,
                keyPrefix: 'mcserver:',
                channels: existingConfig?.redis?.channels || {
                    serverRequest: 'server:request',
                    serverResponse: 'server:response',
                    serverRegister: 'server:register',
                    serverUnregister: 'server:unregister',
                    serverConfig: 'server:config',
                    serverStatus: 'server:status',
                    serverCommand: 'server:command',
                    playerTracking: 'player:tracking',
                    playerJoin: 'player:join',
                    playerLeave: 'player:leave',
                    playerTransfer: 'player:transfer'
                }
            },
            monitoring: existingConfig?.monitoring || {
                enabled: true,
                interval: 5000,
                metricsInterval: 60000,
                metrics: {
                    cpu: true,
                    memory: true,
                    players: true,
                    tps: true
                },
                alerts: {
                    enabled: true,
                    lowTps: 15,
                    highMemory: 90,
                    highCpu: 80
                }
            },
            logging: existingConfig?.logging || {
                enabled: true,
                level: 'info',
                file: './logs/server-manager.log',
                maxSize: '10m',
                maxFiles: 5,
                console: true,
                format: 'json'
            },
            security: {
                apiKey: apiKey,
                apiEnabled: true,
                allowedIPs: existingConfig?.security?.allowedIPs || ['127.0.0.1', 'localhost', '::1'],
                rateLimit: {
                    enabled: true,
                    windowMs: 60000,
                    maxRequests: 100
                },
                corsOrigins: existingConfig?.security?.corsOrigins || ['http://localhost:3000', 'http://localhost:3001']
            },
            features: existingConfig?.features || {
                autoRestart: {
                    enabled: true,
                    onCrash: true,
                    maxRetries: 3,
                    retryDelay: 5000
                },
                playerTracking: {
                    enabled: true,
                    storeHistory: true,
                    historyDays: 30
                },
                serverSync: {
                    enabled: true,
                    syncInterval: 5000
                },
                dynamicScaling: {
                    enabled: true,
                    predictive: false
                },
                loadBalancing: {
                    enabled: true,
                    strategy: 'least-connections',
                    stickyServers: false
                }
            },
            api: existingConfig?.api || {
                enabled: true,
                port: answers.apiPort,
                host: '0.0.0.0',
                dashboard: true,
                websocket: true,
                restApi: true,
                authentication: {
                    enabled: false,
                    type: 'basic',
                    users: []
                }
            },
            cleanup: existingConfig?.cleanup || {
                enabled: true,
                serverLogs: {
                    enabled: true,
                    maxAge: 7,
                    compress: true,
                    schedule: '0 0 * * *'
                },
                crashReports: {
                    enabled: true,
                    maxAge: 30,
                    maxCount: 100
                },
                tempFiles: {
                    enabled: true,
                    maxAge: 1,
                    schedule: '0 */6 * * *'
                }
            },
            backup: existingConfig?.backup || {
                enabled: false,
                schedule: '0 3 * * *',
                retention: 7,
                compress: true,
                includeWorlds: true,
                includePlugins: false,
                includeConfigs: true
            }
        };
        
        await fs.writeJSON(path.join(this.baseDir, 'config.json'), this.config, { spaces: 2 });
        this.log('  ✓ Configuration saved', 'success');
        this.log(`  ✓ API Key: ${apiKey.substring(0, 12)}...`, 'info');
    }

    generateApiKey() {
        const crypto = require('crypto');
        return crypto.randomBytes(32).toString('base64');
    }

    async downloadServerJars() {
        this.log('\n📥 Downloading server JARs...', 'header');
        
        const axios = require('axios');
        
        for (const [name, jar] of Object.entries(this.config.jars)) {
            const jarPath = path.join(this.baseDir, jar.path);
            
            // Check if file exists and is valid size (> 1MB)
            if (await fs.pathExists(jarPath)) {
                const stats = await fs.stat(jarPath);
                if (stats.size > 1000000) {
                    this.log(`  ⏭ ${name} already exists (${(stats.size / 1024 / 1024).toFixed(2)} MB)`, 'info');
                    continue;
                } else {
                    this.log(`  ⚠ ${name} is corrupted (${stats.size} bytes), re-downloading...`, 'warning');
                    await fs.unlink(jarPath);
                }
            }
            
            if (!jar.url) {
                this.log(`  ⚠ No download URL for ${name}`, 'warning');
                continue;
            }
            
            this.log(`  Downloading ${name}...`, 'info');
            
            try {
                const response = await axios({
                    method: 'GET',
                    url: jar.url,
                    responseType: 'stream',
                    timeout: 60000,
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                    }
                });
                
                const totalSize = parseInt(response.headers['content-length'], 10) || null;
                
                if (totalSize) {
                    this.log(`    File size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`, 'info');
                }
                
                const writer = fs.createWriteStream(jarPath);
                let downloadedSize = 0;
                
                response.data.on('data', (chunk) => {
                    downloadedSize += chunk.length;
                    if (totalSize) {
                        const progress = ((downloadedSize / totalSize) * 100).toFixed(1);
                        process.stdout.write(`\r    Progress: ${progress}%`);
                    } else {
                        // No content-length header, just show downloaded amount
                        process.stdout.write(`\r    Downloaded: ${(downloadedSize / 1024 / 1024).toFixed(2)} MB`);
                    }
                });
                
                response.data.pipe(writer);
                
                await new Promise((resolve, reject) => {
                    writer.on('finish', () => {
                        console.log(); // New line after progress
                        resolve();
                    });
                    writer.on('error', reject);
                });
                
                // Verify download
                const finalStats = await fs.stat(jarPath);
                if (totalSize && finalStats.size === totalSize) {
                    this.log(`  ✓ ${name} downloaded successfully`, 'success');
                } else if (!totalSize) {
                    // No content-length to verify against, just check size is reasonable
                    this.log(`  ✓ ${name} downloaded (${(finalStats.size / 1024 / 1024).toFixed(2)} MB)`, 'success');
                } else {
                    this.log(`  ⚠ ${name} size mismatch (expected ${totalSize}, got ${finalStats.size})`, 'warning');
                }
                
                // For Paper 1.8.8, also create a copy with alternate naming if needed
                if (name === 'paper-1.8.8' && jar.path.includes('445')) {
                    const altPath = jar.path.replace('445', '443');
                    const fullAltPath = path.join(this.baseDir, altPath);
                    if (!await fs.pathExists(fullAltPath)) {
                        await fs.copy(jarPath, fullAltPath);
                        this.log(`    Created compatibility copy: ${path.basename(altPath)}`, 'info');
                    }
                }
                
            } catch (error) {
                this.log(`  ⚠ Failed to download ${name}: ${error.message}`, 'warning');
                this.log(`    Please download manually from: ${jar.url}`, 'info');
            }
        }
    }

    async setupTemplates() {
        this.log('\n📋 Setting up configuration templates...', 'header');
        
        // Create all template configurations
        await this.createMinimalTemplate();
        await this.createHubTemplate();
        await this.createGameTemplate();
        await this.createVoidTemplate();
        await this.createLimboTemplate();
        await this.createCreativeTemplate();
        await this.createVelocityTemplate();
        
        // Create plugin README files
        await this.createPluginReadmes();
        
        this.log('  ✓ All templates created', 'success');
    }

    async createMinimalTemplate() {
        const dir = path.join(this.baseDir, 'templates/configs/minimal');
        
        const serverProperties = `# Minimal Server Configuration
server-port=25565
online-mode=false
spawn-protection=0
max-players=20
motd=Minecraft Server
level-type=FLAT
generator-settings=2;0;1;minecraft:air
spawn-monsters=false
spawn-animals=false
spawn-npcs=false
generate-structures=false
pvp=true
difficulty=normal
gamemode=survival
view-distance=2
max-world-size=1000`;

        const bukkitYml = `settings:
  allow-end: false
  warn-on-overload: false
  connection-throttle: -1
spawn-limits:
  monsters: 0
  animals: 0
chunk-gc:
  period-in-ticks: 300`;

        const spigotYml = `config-version: 12
settings:
  bungeecord: true
  save-user-cache-on-stop-only: false
  moved-wrongly-threshold: 0.0625
  timeout-time: 60
  restart-on-crash: false
  netty-threads: 4
world-settings:
  default:
    entity-activation-range:
      animals: 16
      monsters: 24
      misc: 8`;

        await fs.writeFile(path.join(dir, 'server.properties'), serverProperties);
        await fs.writeFile(path.join(dir, 'bukkit.yml'), bukkitYml);
        await fs.writeFile(path.join(dir, 'spigot.yml'), spigotYml);
        await fs.writeFile(path.join(dir, 'eula.txt'), 'eula=true');
        
        this.log('  ✓ Minimal template created', 'success');
    }

    async createHubTemplate() {
        const dir = path.join(this.baseDir, 'templates/configs/hub');
        
        // Copy minimal as base
        await fs.copy(
            path.join(this.baseDir, 'templates/configs/minimal'),
            dir
        );
        
        const serverProperties = `# Hub Server Configuration
server-port=25501
online-mode=false
spawn-protection=100
max-players=100
motd=&b&lHub Server
level-type=FLAT
level-name=hub
spawn-monsters=false
spawn-animals=false
spawn-npcs=true
pvp=false
difficulty=peaceful
gamemode=adventure
allow-flight=true
view-distance=4`;

        await fs.writeFile(path.join(dir, 'server.properties'), serverProperties);
        this.log('  ✓ Hub template created', 'success');
    }

    async createGameTemplate() {
        const dir = path.join(this.baseDir, 'templates/configs/game');
        
        await fs.copy(
            path.join(this.baseDir, 'templates/configs/minimal'),
            dir
        );
        
        const serverProperties = `# Game Server Configuration
server-port=25565
online-mode=false
spawn-protection=0
max-players=16
motd=Game Server
level-type=FLAT
level-name=game
generator-settings=2;0;1;minecraft:air
spawn-monsters=false
spawn-animals=false
spawn-npcs=false
pvp=true
difficulty=normal
gamemode=survival
allow-flight=false
view-distance=4`;

        await fs.writeFile(path.join(dir, 'server.properties'), serverProperties);
        this.log('  ✓ Game template created', 'success');
    }

    async createVoidTemplate() {
        const dir = path.join(this.baseDir, 'templates/configs/void');
        
        await fs.copy(
            path.join(this.baseDir, 'templates/configs/minimal'),
            dir
        );
        
        const serverProperties = `# Void World Configuration
server-port=25565
online-mode=false
spawn-protection=0
max-players=20
level-type=FLAT
level-name=void
generator-settings=2;0;1;minecraft:air
spawn-monsters=false
spawn-animals=false
spawn-npcs=false
generate-structures=false
view-distance=2`;

        await fs.writeFile(path.join(dir, 'server.properties'), serverProperties);
        this.log('  ✓ Void template created', 'success');
    }

    async createLimboTemplate() {
        const dir = path.join(this.baseDir, 'templates/configs/limbo');
        
        await fs.copy(
            path.join(this.baseDir, 'templates/configs/minimal'),
            dir
        );
        
        const serverProperties = `# Limbo Server Configuration
server-port=25599
online-mode=false
spawn-protection=1000
max-players=50
motd=&7Limbo Server
level-type=FLAT
level-name=limbo
generator-settings=2;0;1;minecraft:bedrock
spawn-monsters=false
spawn-animals=false
spawn-npcs=false
pvp=false
difficulty=peaceful
gamemode=adventure
view-distance=2`;

        await fs.writeFile(path.join(dir, 'server.properties'), serverProperties);
        this.log('  ✓ Limbo template created', 'success');
    }

    async createCreativeTemplate() {
        const dir = path.join(this.baseDir, 'templates/configs/creative');
        
        await fs.copy(
            path.join(this.baseDir, 'templates/configs/minimal'),
            dir
        );
        
        const serverProperties = `# Creative Server Configuration
server-port=25565
online-mode=false
spawn-protection=0
max-players=20
motd=&a&lCreative Server
level-type=FLAT
level-name=creative
spawn-monsters=false
spawn-animals=true
spawn-npcs=true
pvp=false
difficulty=peaceful
gamemode=creative
allow-flight=true
view-distance=8`;

        await fs.writeFile(path.join(dir, 'server.properties'), serverProperties);
        this.log('  ✓ Creative template created', 'success');
    }

    async createVelocityTemplate() {
        const dir = path.join(this.baseDir, 'templates/configs/velocity');
        
        const velocityConfig = `# Velocity configuration
config-version = "2.6"
bind = "0.0.0.0:${this.config.proxy?.port || 25565}"
motd = "&3A Velocity Server"
show-max-players = 500
online-mode = false
prevent-client-proxy-connections = false
player-info-forwarding-mode = "legacy"
forwarding-secret-file = "forwarding.secret"
announce-forge = false

[servers]
# Servers will be registered dynamically by the ServerManager plugin

[forced-hosts]

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
log-player-connections = true`;

        await fs.writeFile(path.join(dir, 'velocity.toml'), velocityConfig);
        this.log('  ✓ Velocity template created', 'success');
    }

    async createPluginReadmes() {
        const pluginDirs = {
            'core': 'Core plugins loaded on all servers',
            'hub': 'Hub-specific plugins (lobbies, server selectors)',
            'minigame': 'Base minigame framework plugins',
            'bedwars': 'Bedwars game mode plugins',
            'sumo': 'Sumo game mode plugins',
            'bridge': 'Bridge game mode plugins',
            'worldedit': 'WorldEdit and creative mode plugins'
        };

        for (const [dir, description] of Object.entries(pluginDirs)) {
            const readme = `# ${dir.charAt(0).toUpperCase() + dir.slice(1)} Plugins

${description}

Place plugin JAR files in this directory.
They will be automatically copied to servers that require them.

## Required Plugins:
- Add your ${dir} plugin JARs here

## Configuration:
Plugin configurations will be generated dynamically based on server requirements.`;

            await fs.writeFile(
                path.join(this.baseDir, 'templates/plugins', dir, 'README.md'),
                readme
            );
        }

        // Main plugins README
        const mainReadme = `# Plugin Directory Structure

This directory contains plugins organized by their purpose:

- **core/** - Essential plugins loaded on all servers
- **hub/** - Hub/lobby specific plugins
- **minigame/** - Base minigame framework
- **bedwars/** - Bedwars game plugins
- **sumo/** - Sumo game plugins
- **bridge/** - Bridge game plugins
- **worldedit/** - Creative mode and building plugins

## ServerManager Plugin

The ServerManager plugin (for Velocity) should be built and placed here:
\`templates/plugins/ServerManager-1.0-SNAPSHOT.jar\`

This plugin handles:
- Dynamic server registration with Velocity
- Player routing and load balancing
- Server lifecycle management
- Redis communication with Node.js manager

## Adding Plugins

1. Place plugin JARs in the appropriate subdirectory
2. Update server templates in config to include the plugin category
3. Plugins will be copied automatically when servers are created`;

        await fs.writeFile(
            path.join(this.baseDir, 'templates/plugins/README.md'),
            mainReadme
        );

        this.log('  ✓ Plugin structure created', 'success');
    }

    async createSourceFiles() {
        this.log('\n📄 Creating placeholder source files...', 'header');
        
        // Create a README for the src directory
        const srcReadme = `# Server Manager Source Code

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
- Metrics and monitoring endpoints`;

        await fs.writeFile(
            path.join(this.baseDir, 'src/README.md'),
            srcReadme
        );

        this.log('  ✓ Source structure documented', 'success');
    }

    async setupSystemd() {
        if (process.platform !== 'linux') {
            this.log('\n⏭ Skipping systemd setup (not on Linux)', 'info');
            return;
        }
        
        const response = await prompts({
            type: 'confirm',
            name: 'setupSystemd',
            message: 'Create systemd service file?',
            initial: false
        });
        
        if (!response.setupSystemd) return;
        
        const serviceContent = `[Unit]
Description=Minecraft Server Manager
After=network.target redis.service
Wants=redis.service

[Service]
Type=simple
User=${process.env.USER || 'minecraft'}
WorkingDirectory=${this.baseDir}
ExecStart=/usr/bin/node ${path.join(this.baseDir, 'src/ServerManager.js')}
Restart=always
RestartSec=10
StandardOutput=append:${path.join(this.baseDir, 'logs/manager.log')}
StandardError=append:${path.join(this.baseDir, 'logs/manager.error.log')}

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${this.baseDir}

[Install]
WantedBy=multi-user.target`;

        const servicePath = path.join(this.baseDir, 'minecraft-server-manager.service');
        await fs.writeFile(servicePath, serviceContent);
        
        this.log(`\n✓ Systemd service file created: ${servicePath}`, 'success');
        this.log('  Installation instructions:', 'info');
        this.log('    sudo cp minecraft-server-manager.service /etc/systemd/system/', 'info');
        this.log('    sudo systemctl daemon-reload', 'info');
        this.log('    sudo systemctl enable minecraft-server-manager', 'info');
        this.log('    sudo systemctl start minecraft-server-manager', 'info');
    }

    printNextSteps() {
        console.log();
        if (this.chalk) {
            console.log(this.chalk.green('╔════════════════════════════════════════════════╗'));
            console.log(this.chalk.green('║           Setup Complete! Next Steps:          ║'));
            console.log(this.chalk.green('╚════════════════════════════════════════════════╝'));
            console.log();
            
            console.log(this.chalk.yellow('1. Build and install the ServerManager Velocity plugin:'));
            console.log('   cd velocity-plugin');
            console.log('   mvn package');
            console.log('   cp target/ServerManager-1.0-SNAPSHOT.jar ../templates/plugins/');
            console.log();
            
            console.log(this.chalk.yellow('2. Add your game plugins to the appropriate directories:'));
            console.log('   - Core plugins → templates/plugins/core/');
            console.log('   - Hub plugins → templates/plugins/hub/');
            console.log('   - Game plugins → templates/plugins/minigame/');
            console.log();
            
            console.log(this.chalk.yellow('3. Copy your existing source files or use the provided structure'));
            console.log();
            
            console.log(this.chalk.yellow('4. Start the server manager:'));
            console.log('   ' + this.chalk.cyan('npm start'));
            console.log();
            
            console.log(this.chalk.yellow('5. Access the management dashboard:'));
            console.log('   ' + this.chalk.cyan(`http://localhost:${this.config.ports?.apiPort || 3000}`));
            if (this.config.security?.apiKey) {
                console.log('   ' + this.chalk.gray(`API Key: ${this.config.security.apiKey.substring(0, 12)}...`));
            }
            console.log();
            
            if (this.config.proxy?.enabled) {
                console.log(this.chalk.yellow('6. Connect to your Minecraft server:'));
                console.log('   ' + this.chalk.cyan(`localhost:${this.config.proxy.port}`));
                console.log();
            }
            
            console.log(this.chalk.gray('Additional commands:'));
            console.log(this.chalk.gray('  npm run dev          - Development mode with auto-restart'));
            console.log(this.chalk.gray('  npm run dashboard    - Start dashboard separately'));
            console.log(this.chalk.gray('  tail -f logs/*.log   - Monitor logs'));
            console.log();
            
            // Warnings and notes
            if (!this.javaPaths['8'] && !this.javaPaths['11']) {
                console.log(this.chalk.red('⚠ Warning: Java 8/11 not found. Paper 1.8.8 servers may not start.'));
            }
            if (!this.javaPaths['17'] && !this.javaPaths['21']) {
                console.log(this.chalk.red('⚠ Warning: Java 17/21 not found. Velocity proxy may not start.'));
            }
            if (!this.redisAvailable && this.config.redis?.enabled) {
                console.log(this.chalk.yellow('⚠ Redis is enabled but not running. Start Redis before the manager.'));
                console.log(this.chalk.gray('  sudo systemctl start redis'));
            }
            
            console.log();
            console.log(this.chalk.green('Setup complete! Your server manager is ready to use.'));
        } else {
            // Plain text version without colors
            console.log('╔════════════════════════════════════════════════╗');
            console.log('║           Setup Complete! Next Steps:          ║');
            console.log('╚════════════════════════════════════════════════╝');
            console.log();
            
            console.log('1. Build and install the ServerManager Velocity plugin:');
            console.log('   cd velocity-plugin');
            console.log('   mvn package');
            console.log('   cp target/ServerManager-1.0-SNAPSHOT.jar ../templates/plugins/');
            console.log();
            
            console.log('2. Add your game plugins to the appropriate directories');
            console.log();
            
            console.log('3. Start the server manager:');
            console.log('   npm start');
            console.log();
            
            console.log('4. Access the management dashboard:');
            console.log(`   http://localhost:${this.config.ports?.apiPort || 3000}`);
            console.log();
            
            console.log('Setup complete! Your server manager is ready to use.');
        }
        console.log();
    }
}

// Run setup if executed directly
if (require.main === module) {
    const setup = new ServerManagerSetup();
    setup.run().catch(err => {
        // Use plain console.error since chalk might not be available
        console.error('\n✗ Setup failed:', err.message);
        if (err.stack) {
            console.error(err.stack);
        }
        process.exit(1);
    });
}

module.exports = ServerManagerSetup;