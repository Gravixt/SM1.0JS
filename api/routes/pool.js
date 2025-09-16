// api/routes/pool.js - REST API endpoints only

const express = require('express');
const router = express.Router();

module.exports = (serverManager) => {
    const poolManager = serverManager.poolManager || serverManager.pool;
    const logger = serverManager.logger;
    
    if (!poolManager) {
        logger.error('Pool manager not found in server manager');
        return router;
    }

    // Get pool status
    router.get('/status', (req, res) => {
        try {
            const status = poolManager.getStatus();
            res.json(status);
        } catch (error) {
            logger.error('Error getting pool status:', error);
            res.status(500).json({ error: error.message });
        }
    });

    // Manual scale trigger
    router.post('/scale', async (req, res) => {
        try {
            logger.info('Manual pool scale requested via API');
            
            const result = await poolManager.checkAndScale();
            const status = poolManager.getStatus();
            
            res.json({
                success: true,
                result: result,
                ...status
            });
        } catch (error) {
            logger.error('Error scaling pool:', error);
            res.status(500).json({ 
                success: false,
                error: error.message 
            });
        }
    });

    // Scale up by specific amount
    router.post('/scale-up', async (req, res) => {
        try {
            const count = parseInt(req.body.count) || 1;
            logger.info(`Manual scale up by ${count} requested`);
            
            const added = await poolManager.scaleUp(count);
            const status = poolManager.getStatus();
            
            res.json({
                success: true,
                added: added,
                ...status
            });
        } catch (error) {
            logger.error('Error scaling up pool:', error);
            res.status(500).json({ 
                success: false,
                error: error.message 
            });
        }
    });

    // Scale down by specific amount
    router.post('/scale-down', async (req, res) => {
        try {
            const count = parseInt(req.body.count) || 1;
            logger.info(`Manual scale down by ${count} requested`);
            
            const removed = await poolManager.scaleDown(count);
            const status = poolManager.getStatus();
            
            res.json({
                success: true,
                removed: removed,
                ...status
            });
        } catch (error) {
            logger.error('Error scaling down pool:', error);
            res.status(500).json({ 
                success: false,
                error: error.message 
            });
        }
    });

    return router;
};