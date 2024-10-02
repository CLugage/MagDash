const express = require('express');
const Container = require('../models/Container');
const generateRandomPassword = require('../utils/generatePassword');
const axios = require('axios'); // Use axios to make HTTP requests to the Proxmox API
const config = require('../config.json'); // Import config.json
const { exec } = require('child_process'); // For executing NAT scripts

const router = express.Router();

// Extract templates and plans from config
const osTemplates = config.templates;
const plans = config.plans;

// Function to authenticate with Proxmox API
const authenticateWithProxmox = async () => {
    try {
        const response = await axios.post(`https://${config.proxmox.host}:8006/api2/json/access/ticket`, {
            username: config.proxmox.username,
            password: config.proxmox.password,
        }, {
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }), // Disable SSL verification (optional)
        });
        return response.data.data;
    } catch (error) {
        console.error('Proxmox authentication failed:', error);
        throw new Error('Authentication failed');
    }
};

// Function to get the next available VMID
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

    let nextIP = config.network.startFromIP; // Start from configured IP
    while (usedIPs.includes(nextIP)) {
        nextIP++;
    }
    return nextIP; // Return the next available IP address
};

// Function to generate and run NAT scripts
const createAndRunNATScript = (container) => {
    const { vmid, net0 } = container;
    const ipMatch = net0.match(/ip=([^,]+)/); // Extract the IP address
    const portMatch = net0.match(/port=(\d+)/); // Extract the port

    if (!ipMatch || !portMatch) {
        console.error(`Invalid net0 format for container ${vmid}: ${net0}`);
        return;
    }

    const ip = ipMatch[1]; // Correctly get the IP address
    const port = portMatch[1]; // Correctly get the port number

    const natScript = `
# NAT for container ${vmid}
iptables -t nat -A PREROUTING -p tcp -d ${ip} --dport ${port} -j DNAT --to-destination ${ip}:${port}
iptables -A FORWARD -p tcp -d ${ip} --dport ${port} -j ACCEPT
`;

    // Save NAT script to a file and execute it
    exec(`echo "${natScript}" > ${config.proxmox.natScriptPath}${vmid}.sh && chmod +x ${config.proxmox.natScriptPath}${vmid}.sh && ${config.proxmox.natScriptPath}${vmid}.sh`, (error) => {
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

    // Get Proxmox authentication ticket
    let proxmoxAuth;
    try {
        proxmoxAuth = await authenticateWithProxmox();
    } catch (error) {
        return res.status(500).send('Error authenticating with Proxmox');
    }

    // Get next VMID
    const vmid = await getNextVMID();

    // Set memory, cores, and disk space based on selected plan
    const planConfig = plans[plan];
    if (!planConfig) return res.status(400).send('Invalid plan selected');

    const { memory, cores, disk } = planConfig;

    // Generate a random SSH port within configured range
    const randomPort = Math.floor(Math.random() * (config.ssh.portRange.max - config.ssh.portRange.min + 1)) + config.ssh.portRange.min;

    // Get the next available IP address
    const nextIP = await getNextIP();
    const net0 = `name=eth0,bridge=vmbr1,ip=${config.network.baseIP}${nextIP},port=${randomPort}`;

    // Generate a random password for the container
    const containerPassword = generateRandomPassword();

    const newContainer = new Container({
        vmid,
        name,
        memory,
        cores,
        disk,
        net0,
        template,
        userId: req.user._id,
        password: containerPassword,
    });

    try {
        await newContainer.save(); // Save container to MongoDB
        await createContainerOnProxmox({ vmid, name, memory, cores, disk, net0, template, containerPassword, proxmoxAuth });
        createAndRunNATScript(newContainer);
        await updateSSHDConfig(newContainer, proxmoxAuth);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(error);
        res.status(500).send('Error creating container');
    }
});

// Function to create a container on Proxmox
const createContainerOnProxmox = async ({ vmid, name, memory, cores, disk, net0, template, containerPassword, proxmoxAuth }) => {
    const { ticket, CSRFPreventionToken } = proxmoxAuth;

    const createCommand = {
        vmid,
        hostname: name,
        ostemplate: template,
        memory,
        cores,
        net0,
        rootfs: `local:${disk}`,
        password: containerPassword // Pass password directly
    };

    try {
        // Create the container using Proxmox API
        await axios.post(`https://${config.proxmox.host}:8006/api2/json/nodes/${config.proxmox.node}/lxc`, createCommand, {
            headers: {
                'Authorization': `PVEAPIToken=${ticket}`,
                'CSRFPreventionToken': CSRFPreventionToken,
                'Content-Type': 'application/json',
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }), // Disable SSL verification (optional)
        });
        console.log(`Container created: ${vmid}`);
    } catch (error) {
        console.error(`Error creating container: ${error.response ? error.response.data : error.message}`);
    }
};

// Handle fetching containers for the logged-in user
router.get('/', async (req, res) => {
    try {
        // Fetch containers associated with the logged-in user
        const containers = await Container.find({ userId: req.user._id });
        
        // Render the dashboard and include containers, OS templates, and plans
        res.render('dashboard', {
            containers,
            osTemplates: config.templates,
            plans: config.plans // Include plans in the rendering
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error fetching containers');
    }
});

// Function to update SSH configuration
const updateSSHDConfig = async (container, proxmoxAuth) => {
    const { vmid, password } = container;

    try {
        const { ticket, CSRFPreventionToken } = proxmoxAuth;

        // Update the SSH configuration via pct exec (if required)
        await axios.post(`https://${config.proxmox.host}:8006/api2/json/nodes/${config.proxmox.node}/lxc/${vmid}/exec`, {
            command: `bash -c "echo '${password}' | passwd root --stdin && sed -i 's/#PermitRootLogin/PermitRootLogin/' /etc/ssh/sshd_config && systemctl restart sshd"`,
        }, {
            headers: {
                'Authorization': `PVEAPIToken=${ticket}`,
                'CSRFPreventionToken': CSRFPreventionToken,
                'Content-Type': 'application/json',
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }), // Disable SSL verification (optional)
        });

        console.log(`SSHD config updated for container ${vmid}`);
    } catch (error) {
        console.error(`Error updating SSHD config: ${error.response ? error.response.data : error.message}`);
    }
};

// Handle starting a container
router.post('/:id/start', async (req, res) => {
    const { id } = req.params;

    try {
        const proxmoxAuth = await authenticateWithProxmox(); // Authenticate with Proxmox

        await axios.post(`https://${config.proxmox.host}:8006/api2/json/nodes/${config.proxmox.node}/lxc/${id}/status/start`, {}, {
            headers: {
                'Authorization': `PVEAPIToken=${proxmoxAuth.ticket}`,
                'CSRFPreventionToken': proxmoxAuth.CSRFPreventionToken,
                'Content-Type': 'application/json',
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }), // Disable SSL verification (optional)
        });
        console.log(`Container ${id} started`);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(`Error starting container: ${error.response ? error.response.data : error.message}`);
        res.status(500).send('Error starting container');
    }
});

// Handle stopping a container
router.post('/:id/stop', async (req, res) => {
    const { id } = req.params;

    try {
        const proxmoxAuth = await authenticateWithProxmox(); // Authenticate with Proxmox

        await axios.post(`https://${config.proxmox.host}:8006/api2/json/nodes/${config.proxmox.node}/lxc/${id}/status/stop`, {}, {
            headers: {
                'Authorization': `PVEAPIToken=${proxmoxAuth.ticket}`,
                'CSRFPreventionToken': proxmoxAuth.CSRFPreventionToken,
                'Content-Type': 'application/json',
            },
            httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }), // Disable SSL verification (optional)
        });
        console.log(`Container ${id} stopped`);
        res.redirect('/dashboard');
    } catch (error) {
        console.error(`Error stopping container: ${error.response ? error.response.data : error.message}`);
        res.status(500).send('Error stopping container');
    }
});

module.exports = router;
