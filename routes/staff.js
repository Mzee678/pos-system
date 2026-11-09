const express = require('express');
const router = express.Router();
const path = require('path');
router.get('/', (req, res) => res.sendFile(path.join(__dirname, '../views/staff.html')));
router.get('/{*splat}', (req, res) => res.sendFile(path.join(__dirname, '../views/staff.html')));
module.exports = router;
