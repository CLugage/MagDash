// proxmox.js
const axios = require('axios');

const PROXMOX_API_URL = 'https://your-proxmox-server:8006/api2/json/nodes/your-node-name/lxc';
const PROXMOX_USER = 'your-username@pam';
const PROXMOX_PASS = 'your-password';

// Authentication
const auth = async () => {
  const response = await axios.post(`${PROXMOX_API_URL}/access/ticket`, {
    username: PROXMOX_USER,
    password: PROXMOX_PASS,
  });
  return response.data.data;
};

// Create LXC Container
const createContainer = async (containerData) => {
  const { ticket, csrfToken } = await auth();
  const response = await axios.post(`${PROXMOX_API_URL}`, containerData, {
    headers: {
      'CSRFPreventionToken': csrfToken,
      'Cookie': `PVEAuthCookie=${ticket}`,
    },
  });
  return response.data;
};

// Start LXC Container
const startContainer = async (vmid) => {
  const { ticket, csrfToken } = await auth();
  await axios.post(`${PROXMOX_API_URL}/${vmid}/status/start`, {}, {
    headers: {
      'CSRFPreventionToken': csrfToken,
      'Cookie': `PVEAuthCookie=${ticket}`,
    },
  });
};

// Stop LXC Container
const stopContainer = async (vmid) => {
  const { ticket, csrfToken } = await auth();
  await axios.post(`${PROXMOX_API_URL}/${vmid}/status/stop`, {}, {
    headers: {
      'CSRFPreventionToken': csrfToken,
      'Cookie': `PVEAuthCookie=${ticket}`,
    },
  });
};

module.exports = {
  createContainer,
  startContainer,
  stopContainer,
};
