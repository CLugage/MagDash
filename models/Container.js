const mongoose = require('mongoose');

const ContainerSchema = new mongoose.Schema({
    vmid: { type: Number, required: true, unique: true },
    name: { type: String, required: true },
    memory: { type: Number, required: true },
    cores: { type: Number, required: true },
    net0: { type: String, required: true },
    template: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
});

module.exports = mongoose.model('Container', ContainerSchema);
