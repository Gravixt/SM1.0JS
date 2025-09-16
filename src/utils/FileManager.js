// src/utils/FileManager.js - File Operations Utility

const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class FileManager {
    constructor(baseDir = process.cwd()) {
        this.baseDir = baseDir;
    }
    
    async ensureDirectory(dirPath) {
        const fullPath = this.resolvePath(dirPath);
        await fs.ensureDir(fullPath);
        return fullPath;
    }
    
    async copyDirectory(source, destination, options = {}) {
        const sourcePath = this.resolvePath(source);
        const destPath = this.resolvePath(destination);
        
        await fs.copy(sourcePath, destPath, {
            overwrite: options.overwrite !== false,
            errorOnExist: options.errorOnExist || false,
            filter: options.filter || (() => true)
        });
        
        return destPath;
    }
    
    async readJson(filePath) {
        const fullPath = this.resolvePath(filePath);
        return await fs.readJson(fullPath);
    }
    
    async writeJson(filePath, data, options = {}) {
        const fullPath = this.resolvePath(filePath);
        await fs.writeJson(fullPath, data, {
            spaces: options.spaces || 2,
            ...options
        });
        return fullPath;
    }
    
    async readFile(filePath, encoding = 'utf8') {
        const fullPath = this.resolvePath(filePath);
        return await fs.readFile(fullPath, encoding);
    }
    
    async writeFile(filePath, data) {
        const fullPath = this.resolvePath(filePath);
        await fs.writeFile(fullPath, data);
        return fullPath;
    }
    
    async exists(filePath) {
        const fullPath = this.resolvePath(filePath);
        return await fs.pathExists(fullPath);
    }
    
    async remove(filePath) {
        const fullPath = this.resolvePath(filePath);
        await fs.remove(fullPath);
    }
    
    async listDirectory(dirPath, options = {}) {
        const fullPath = this.resolvePath(dirPath);
        const items = await fs.readdir(fullPath);
        
        if (options.fullPaths) {
            return items.map(item => path.join(fullPath, item));
        }
        
        if (options.withStats) {
            const itemsWithStats = [];
            for (const item of items) {
                const itemPath = path.join(fullPath, item);
                const stats = await fs.stat(itemPath);
                itemsWithStats.push({
                    name: item,
                    path: itemPath,
                    isDirectory: stats.isDirectory(),
                    isFile: stats.isFile(),
                    size: stats.size,
                    modified: stats.mtime
                });
            }
            return itemsWithStats;
        }
        
        return items;
    }
    
    async getSize(filePath) {
        const fullPath = this.resolvePath(filePath);
        const stats = await fs.stat(fullPath);
        
        if (stats.isFile()) {
            return stats.size;
        }
        
        if (stats.isDirectory()) {
            return await this.getDirectorySize(fullPath);
        }
        
        return 0;
    }
    
    async getDirectorySize(dirPath) {
        let size = 0;
        const items = await fs.readdir(dirPath);
        
        for (const item of items) {
            const itemPath = path.join(dirPath, item);
            const stats = await fs.stat(itemPath);
            
            if (stats.isFile()) {
                size += stats.size;
            } else if (stats.isDirectory()) {
                size += await this.getDirectorySize(itemPath);
            }
        }
        
        return size;
    }
    
    async createBackup(filePath, backupDir = 'backups') {
        const fullPath = this.resolvePath(filePath);
        const backupPath = this.resolvePath(backupDir);
        
        await fs.ensureDir(backupPath);
        
        const timestamp = new Date().toISOString().replace(/:/g, '-').split('.')[0];
        const fileName = path.basename(fullPath);
        const backupFileName = `${fileName}.${timestamp}.backup`;
        const backupFullPath = path.join(backupPath, backupFileName);
        
        await fs.copy(fullPath, backupFullPath);
        
        return backupFullPath;
    }
    
    async getChecksum(filePath, algorithm = 'sha256') {
        const fullPath = this.resolvePath(filePath);
        const hash = crypto.createHash(algorithm);
        const stream = fs.createReadStream(fullPath);
        
        return new Promise((resolve, reject) => {
            stream.on('data', data => hash.update(data));
            stream.on('end', () => resolve(hash.digest('hex')));
            stream.on('error', reject);
        });
    }
    
    resolvePath(filePath) {
        if (path.isAbsolute(filePath)) {
            return filePath;
        }
        return path.join(this.baseDir, filePath);
    }
    
    async findFiles(pattern, searchDir = '.') {
        const fullPath = this.resolvePath(searchDir);
        const results = [];
        
        async function search(dir) {
            const items = await fs.readdir(dir);
            
            for (const item of items) {
                const itemPath = path.join(dir, item);
                const stats = await fs.stat(itemPath);
                
                if (stats.isDirectory()) {
                    await search(itemPath);
                } else if (stats.isFile()) {
                    if (pattern instanceof RegExp) {
                        if (pattern.test(item)) {
                            results.push(itemPath);
                        }
                    } else if (typeof pattern === 'string') {
                        if (item.includes(pattern)) {
                            results.push(itemPath);
                        }
                    }
                }
            }
        }
        
        await search(fullPath);
        return results;
    }
    
    async cleanDirectory(dirPath, options = {}) {
        const fullPath = this.resolvePath(dirPath);
        const maxAge = options.maxAge || 7 * 24 * 60 * 60 * 1000; // 7 days default
        const now = Date.now();
        
        const items = await this.listDirectory(dirPath, { withStats: true });
        
        for (const item of items) {
            if (item.isFile) {
                const age = now - item.modified.getTime();
                if (age > maxAge) {
                    await fs.remove(item.path);
                }
            }
        }
    }
}

module.exports = FileManager;