const express = require('express');
const Container = require('../models/Container');
const axios = require('axios');
const generateRandomPassword = require('../utils/generatePassword');
const { exec } = require('child_process');

const router = express.Router();

// Function to get the next available IP address
const getNextIP = async () => {
    const containers = await Container.find();
    const usedIPs = containers.map(container => {
        return parseInt(container.net0.split('.')[3]);
    });

    let nextIP = 3; // Start from 10.10.10.3
    while (usedIPs.includes(nextIP)) {
        nextIP++;
    }
    return nextIP; // Return the next available IP address
};

// Function to generate and run NAT scripts
const createAndRunNATScript = (container) => {
    const { vmid, net0 } = container;
    const ip = net0.split(',')[1].split('=')[1];
    const port = net0.split(',')[2].split('=')[1];

    const natScript = `
# NAT for container ${vmid}
iptables -t nat -A PREROUTING -p tcp -d 10.10.10.${ip} --dport ${port} -j DNAT --to-destination 10.10.10.${ip}:${port}
iptables -A FORWARD -p tcp -d 10.10.10.${ip} --dport ${port} -j ACCEPT
`;

    // Save NAT script to a file and execute it
    exec(`echo "${natScript}" > /etc/iptables/nat-${vmid}.sh && chmod +x /etc/iptables/nat-${vmid}.sh && /etc/iptables/nat-${vmid}.sh`, (error) => {
        if (error) {
            console.error(`Error creating or running NAT script: ${error}`);
        } else {
            console.log(`NAT script created and executed for container ${vmid}`);
        }
    });
};

// Handle creating a new LXC container
router.post('/', async (req, res) => {
    const { vmid, name, memory, cores, template } = req.body;

    // Generate a random SSH port between 2000 and 60000
    const randomPort = Math.floor(Math.random() * (60000 - 2000 + 1)) + 2000;

    // Get the next available IP address
    const nextIP = await getNextIP();
    const net0 = `name=eth0,bridge=vmbr1,ip=10.10.10.${nextIP},port=${randomPort}`;

    // Generate a random password for the container
    const containerPassword = generateRandomPassword();

    const newContainer = new Container({
        vmid,
        name,
        memory,
        cores,
        net0,
        template,
        userId: req.user._id,
        password: containerPassword,
    });

    try {
        await newContainer.save(); // Save container to MongoDB
        // Create the container on Proxmox
        await createContainerOnProxmox({ vmid, name, memory, cores, net0, template, containerPassword });

        // Create and run NAT script for the container
        createAndRunNATScript(newContainer);

        // Add SSH configuration (if needed)
        await updateSSHDConfig(newContainer);

        res.redirect('/dashboard'); // Redirect to the dashboard after creation
    } catch (error) {
        console.error(error);
        res.status(500).send('Error creating container');
    }
});

// Function to create a container on Proxmox with password
const createContainerOnProxmox = async (containerData) => {
    const { vmid, name, memory, cores, net0, template, containerPassword } = containerData;

    try {
        const response = await axios.post(`${process.env.PROXMOX_URL}/nodes/YOUR_NODE/lxc`, {
            vmid,
            hostname: name,
            memory,
            cores,
            net0,
            ostemplate: template,
            password: containerPassword,
        }, {
            auth: {
                username: process.env.PROXMOX_USER,
                password: process.env.PROXMOX_PASSWORD,
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        });
        return response.data;
    } catch (error) {
        console.error('Error creating container:', error);
        throw new Error('Error creating container on Proxmox');
    }
};

// Handle fetching containers for the logged-in user
router.get('/', async (req, res) => {
    try {
        const containers = await Container.find({ userId: req.user._id });
        res.render('dashboard', { containers });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error fetching containers');
    }
});

// Function to update SSH configuration
const updateSSHDConfig = async (container) => {
    const { vmid, password } = container;

    const command = `
        pct set ${vmid} --password ${password} &&
        pct exec ${vmid} -- bash -c "sed -i 's/#PermitRootLogin/PermitRootLogin/' /etc/ssh/sshd_config" &&
        pct exec ${vmid} -- systemctl restart sshd
    `;

    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error updating SSHD config: ${error}`);
            return;
        }
        console.log(`SSHD config updated for container ${vmid}: ${stdout}`);
    });
};

// Handle starting a container
router.post('/:id/start', async (req, res) => {
    const { id } = req.params;

    try {
        exec(`pct start ${id}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error starting container: ${error}`);
                return res.status(500).send('Error starting container');
            }
            console.log(`Container ${id} started: ${stdout}`);
            res.redirect('/dashboard');
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error starting container');
    }
});

// Handle stopping a container
router.post('/:id/stop', async (req, res) => {
    const { id } = req.params;

    try {
        exec(`pct stop ${id}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error stopping container: ${error}`);
                return res.status(500).send('Error stopping container');
            }
            console.log(`Container ${id} stopped: ${stdout}`);
            res.redirect('/dashboard');
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error stopping container');
    }
});

module.exports = router;
