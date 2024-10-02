// models/User.js
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Define the User schema
const userSchema = new mongoose.Schema({
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // This will store the hashed password
});

// Method to hash the password before saving a user
userSchema.pre('save', async function (next) {
    if (!this.isModified('password')) return next(); // If password hasn't changed, move on
    try {
        const salt = await bcrypt.genSalt(10);
        this.password = await bcrypt.hash(this.password, salt); // Hash the password
        next();
    } catch (err) {
        next(err);
    }
});

// Method to compare the entered password with the stored hashed password
userSchema.methods.verifyPassword = async function (enteredPassword) {
    return await bcrypt.compare(enteredPassword, this.password);
};

// Create and export the User model
const User = mongoose.model('User', userSchema);
module.exports = User;
