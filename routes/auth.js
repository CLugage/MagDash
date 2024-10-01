const express = require('express');
const passport = require('passport');
const bcrypt = require('bcryptjs');
const User = require('../models/User');

const router = express.Router();

// Login page
router.get('/login', (req, res) => {
    res.render('login', { message: req.flash('error') });
});

// Login handling
router.post('/login', passport.authenticate('local', {
    successRedirect: '/dashboard',
    failureRedirect: '/login',
    failureFlash: true,
}));

// Registration page
router.get('/register', (req, res) => {
    res.render('register');
});

// Registration handling
router.post('/register', async (req, res) => {
    const { username, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ username, password: hashedPassword });

    try {
        await user.save();
        res.redirect('/login');
    } catch (err) {
        console.error(err);
        res.redirect('/register');
    }
});

// Logout
router.post('/logout', (req, res) => {
    req.logout();
    res.redirect('/');
});

module.exports = router;
