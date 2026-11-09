const express = require('express');
const router = express.Router();
const path = require('path');
router.get('/', (req, res) => res.sendFile(path.join(__dirname, '../views/manager.html')));
router.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '../views/manager.html')));
module.exports = router;
