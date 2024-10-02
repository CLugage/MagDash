const express = require('express');
const Container = require('../models/Container');
const axios = require('axios');
const generateRandomPassword = require('../utils/generatePassword');
const { exec } = require('child_process');

const router = express.Router();


const getNextVMID = async () => {
    const containers = await Container.find();
    const usedVMIDs = containers.map(container => container.vmid);

    let nextVMID = 100; // Start from 100
    while (usedVMIDs.includes(nextVMID)) {
        nextVMID++;
    }
    return nextVMID;
};


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

// Function to get OS templates from Proxmox
const getOSTemplates = async () => {
    try {
        const response = await axios.get(`${process.env.PROXMOX_URL}/nodes/YOUR_NODE/storage/local/content`, {
            params: { content: 'vztmpl' },
            auth: {
                username: process.env.PROXMOX_USER,
                password: process.env.PROXMOX_PASSWORD,
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        });
        return response.data.data.map(template => template.volid);
    } catch (error) {
        console.error('Error fetching OS templates:', error);
        return [];
    }
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
    const { name, template, plan } = req.body;

    // Get next VMID
    const vmid = await getNextVMID();

    // Set memory, cores, and disk space based on selected plan
    let memory, cores, disk;
    switch (plan) {
        case 'basic':
            memory = 512; // MB
            cores = 1;
            disk = 8; // GB
            break;
        case 'standard':
            memory = 1024; // MB
            cores = 2;
            disk = 20; // GB
            break;
        case 'premium':
            memory = 2048; // MB
            cores = 4;
            disk = 50; // GB
            break;
        default:
            return res.status(400).send('Invalid plan selected');
    }

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
        disk, // Store disk size
        net0,
        template,
        userId: req.user._id,
        password: containerPassword,
    });

    try {
        await newContainer.save(); // Save container to MongoDB
        await createContainerOnProxmox({ vmid, name, memory, cores, disk, net0, template, containerPassword }); // Pass disk to the creation function
        createAndRunNATScript(newContainer);
        await updateSSHDConfig(newContainer);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error creating container');
    }
});


// Function to create a container on Proxmox with password
const createContainerOnProxmox = async ({ vmid, name, memory, cores, disk, net0, template, containerPassword }) => {
    const createCommand = `qm create ${vmid} --name ${name} --memory ${memory} --cores ${cores} --net0 ${net0} --ostemplate ${template} --rootfs local:${disk} --password ${containerPassword}`;
    exec(createCommand, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error creating container: ${stderr}`);
            return;
        }
        console.log(`Container created: ${stdout}`);
    });
};


// Handle fetching containers for the logged-in user
router.get('/', async (req, res) => {
    try {
        const containers = await Container.find({ userId: req.user._id });
        const templates = await getOSTemplates(); // Fetch OS templates
        res.render('dashboard', { containers, templates });
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
