const express = require('express');
const mongoose = require('mongoose');
const session = require('express-session');
const passport = require('passport');
const bodyParser = require('body-parser');
const flash = require('connect-flash');
const path = require('path');
const LocalStrategy = require('passport-local').Strategy;


const User = require('./models/User');
const Container = require('./models/Container');
const authRoutes = require('./routes/auth');
const containerRoutes = require('./routes/containers');
const config = require('config.json')

const app = express();

// Database connection
mongoose.connect('mongodb://localhost:27017/proxmox-panel', {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected'))
.catch(err => console.error(err));

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(session({
    secret: 'your_secret_key',
    resave: false,
    saveUninitialized: true,
}));
app.use(passport.initialize());
app.use(passport.session());
app.use(flash());

// Passport config

// Configure the LocalStrategy
passport.use(new LocalStrategy(async (username, password, done) => {
    try {
        // Find the user by username (assuming username is unique)
        const user = await User.findOne({ username });

        // If no user is found, return an error
        if (!user) {
            return done(null, false, { message: 'Incorrect username.' });
        }

        // Verify the password (ensure you have a function like user.verifyPassword)
        const isMatch = await user.verifyPassword(password);

        // If the password does not match, return an error
        if (!isMatch) {
            return done(null, false, { message: 'Incorrect password.' });
        }

        // If everything is correct, return the user
        return done(null, user);
    } catch (err) {
        return done(err);
    }
}));

// Serialize the user into the session
passport.serializeUser((user, done) => {
    done(null, user._id); // Only store the user's ID in the session
});

// Deserialize the user from the session
passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id); // Fetch user by ID
        done(null, user); // Attach user to the request object (req.user)
    } catch (err) {
        done(err);
    }
});

module.exports = passport;



// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/', authRoutes);
app.use('/containers', containerRoutes);

// Home route
app.get('/', (req, res) => {
    res.render('index', { message: req.flash('message') });
});

// Dashboard route
app.get('/dashboard', async (req, res) => {
    if (!req.isAuthenticated()) {
        return res.redirect('/login');
    }
    
    try {
        const containers = await Container.find({ userId: req.user._id }); // Fetch containers for the logged-in user
        res.render('dashboard', { 
            containers, 
            osTemplates: config.templates, // Pass OS templates
            plans: config.plans // Pass plans
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Error fetching containers');
    }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
