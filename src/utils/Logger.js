// src/utils/Logger.js - Centralized Logging Utility

const winston = require('winston');
const path = require('path');
const fs = require('fs-extra');

class Logger {
    constructor(module = 'General') {
        this.module = module;
        
        // Ensure logs directory exists
        const logsDir = path.join(process.cwd(), 'logs');
        fs.ensureDirSync(logsDir);
        
        // Create winston logger
        this.winston = winston.createLogger({
            level: process.env.LOG_LEVEL || 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                winston.format.errors({ stack: true }),
                winston.format.json()
            ),
            defaultMeta: { module: this.module },
            transports: [
                // Console transport
                new winston.transports.Console({
                    format: winston.format.combine(
                        winston.format.colorize(),
                        winston.format.simple(),
                        winston.format.printf(({ level, message, timestamp, module }) => {
                            const time = new Date(timestamp).toLocaleTimeString();
                            return `[${time}] [${module}] ${level}: ${message}`;
                        })
                    )
                }),
                // File transport
                new winston.transports.File({
                    filename: path.join(logsDir, 'error.log'),
                    level: 'error'
                }),
                new winston.transports.File({
                    filename: path.join(logsDir, 'server-manager.log')
                })
            ]
        });
    }
    
    // Log methods
    info(message, meta = {}) {
        this.winston.info(message, meta);
    }
    
    warn(message, meta = {}) {
        this.winston.warn(message, meta);
    }
    
    error(message, meta = {}) {
        this.winston.error(message, meta);
    }
    
    debug(message, meta = {}) {
        this.winston.debug(message, meta);
    }
    
    verbose(message, meta = {}) {
        this.winston.verbose(message, meta);
    }
    
    // Set log level
    setLevel(level) {
        this.winston.level = level;
    }
    
    // Child logger for sub-modules
    child(module) {
        return new Logger(`${this.module}:${module}`);
    }
}

module.exports = Logger;