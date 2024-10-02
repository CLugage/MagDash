const express = require('express');
const Container = require('../models/Container');
const generateRandomPassword = require('../utils/generatePassword');
const { exec } = require('child_process');
const config = require('../config.json'); // Import config.json

const router = express.Router();

// Extract templates and plans from config
const osTemplates = config.templates;
const plans = config.plans;

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
    const ip = net0.split(',')[1].split('=')[1];
    const port = net0.split(',')[2].split('=')[1];

    const natScript = `
# NAT for container ${vmid}
iptables -t nat -A PREROUTING -p tcp -d ${config.network.baseIP}${ip} --dport ${port} -j DNAT --to-destination ${config.network.baseIP}${ip}:${port}
iptables -A FORWARD -p tcp -d ${config.network.baseIP}${ip} --dport ${port} -j ACCEPT
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
    const createCommand = `${config.proxmox.createCommand} ${vmid} --name ${name} --memory ${memory} --cores ${cores} --net0 ${net0} --ostemplate ${template} --rootfs local:${disk} --password ${containerPassword}`;
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
        res.render('dashboard', { containers, osTemplates, plans }); // Pass plans to the dashboard
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
        exec(`${config.proxmox.startCommand} ${id}`, (error, stdout, stderr) => {
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
        exec(`${config.proxmox.stopCommand} ${id}`, (error, stdout, stderr) => {
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
