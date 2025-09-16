// src/NetworkManager.js - Port Management and Health Checks

const net = require('net');
const Logger = require('./utils/Logger');

class NetworkManager {
    constructor(configManager) {
        this.config = configManager;
        this.logger = new Logger('NetworkManager');
        this.allocatedPorts = new Set();
        this.portRange = {
            start: this.config.get('dynamicServers.startPort', 25601),
            end: this.config.get('dynamicServers.startPort', 25601) + 
                 this.config.get('dynamicServers.maxServers', 20)
        };
    }

    async allocatePort() {
        for (let port = this.portRange.start; port <= this.portRange.end; port++) {
            if (!this.allocatedPorts.has(port)) {
                const available = await this.isPortAvailable(port);
                
                if (available) {
                    this.allocatedPorts.add(port);
                    this.logger.debug(`Allocated port ${port}`);
                    return port;
                }
            }
        }
        
        this.logger.error('No available ports in range');
        return null;
    }

    async releasePort(port) {
        this.allocatedPorts.delete(port);
        this.logger.debug(`Released port ${port}`);
    }

    async isPortAvailable(port) {
        return new Promise((resolve) => {
            const server = net.createServer();
            
            server.once('error', (err) => {
                if (err.code === 'EADDRINUSE') {
                    resolve(false);
                } else {
                    resolve(false);
                }
            });
            
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            
            server.listen(port, '127.0.0.1');
        });
    }

    async checkPort(port, timeout = 1000) {
        return new Promise((resolve) => {
            const client = new net.Socket();
            let resolved = false;
            
            const cleanup = () => {
                if (!resolved) {
                    resolved = true;
                    client.destroy();
                }
            };
            
            client.setTimeout(timeout);
            
            client.once('connect', () => {
                cleanup();
                resolve(true);
            });
            
            client.once('timeout', () => {
                cleanup();
                resolve(false);
            });
            
            client.once('error', () => {
                cleanup();
                resolve(false);
            });
            
            client.connect(port, '127.0.0.1');
        });
    }

    async scanPorts() {
        const results = [];
        
        for (let port = this.portRange.start; port <= this.portRange.end; port++) {
            const inUse = await this.checkPort(port);
            results.push({ port, inUse });
        }
        
        return results;
    }

    getStatus() {
        return {
            allocatedPorts: Array.from(this.allocatedPorts),
            portRange: this.portRange,
            totalPorts: this.portRange.end - this.portRange.start + 1,
            usedPorts: this.allocatedPorts.size
        };
    }
}

module.exports = NetworkManager;