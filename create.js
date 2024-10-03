require(dotenv).config()
const fs = require('fs');
const shell = require('shelljs');

const { workerData } = require('worker_threads');

const { name, proxID, ip, sshPort, os } = workerData;

const db = require('./db');

async function main(name, proxID, ip, sshPort, os) {
    console.log(`Creating ${name} with ${proxID} | ${ip} | ${sshPort.port}:22 | ${os}`);

    const userVPS = await db.VPS.findOne({
        proxID
    });

    if (!userVPS) return console.error(`VPS not found: ${proxID}`);

    var osPath = 'alpine-3.20-default_20240908_amd64.tar.xz';
    if (os == 'debian') osPath = 'debian-12-standard_12.7-1_amd64.tar.zst';

    var createCMD = getCreateCMD(osPath, proxID, userVPS);
    console.log(createCMD);
    var vpsCreateRes = await shell.exec(createCMD);

    if (vpsCreateRes.stderr.length > 0) {
        userVPS.status = 'error';
        await userVPS.save();

        return console.error(vpsCreateRes.stderr);
    }

    await shell.exec(`cp /etc/pve/firewall/100.fw /etc/pve/firewall/${proxID}.fw`);

    if (os == 'alpine') {

        await shell.exec(`pct exec ${proxID} sh -- -c "apk update"`);
        await shell.exec(`pct exec ${proxID} sh -- -c "apk add openssh zsh git wget curl htop sudo bash htop neofetch"`);

        // SSH
        await shell.exec(`pct exec ${proxID} sh -- -c "echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config"`);
        await shell.exec(`pct exec ${proxID} sh -- -c "rc-update add sshd"`);
        await shell.exec(`pct exec ${proxID} sh -- -c "service sshd start"`);

        // MOTD
        await shell.exec(`pct exec ${proxID} sh -- -c "echo '\tFree VPS by Dekos.' > /etc/motd"`);

        // SHELL
        await shell.exec(`pct exec ${proxID} sh -- -c "bash <(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"`);
        await shell.exec(`pct exec ${proxID} sh -- -c "sed -i 's#/bin/ash#/bin/zsh#' /etc/passwd"`);
        await shell.exec(`pct exec ${proxID} sh -- -c "sed -i 's#/bin/sh#/bin/zsh#' /etc/passwd"`);
        await shell.exec(`pct exec ${proxID} sh -- -c "sed -i 's#/bin/bash#/bin/zsh#' /etc/passwd"`);

    }
    if (os == 'debian') {
        await shell.exec(`pct exec ${proxID} bash -- -c "apt update -y"`);
        await shell.exec(`pct exec ${proxID} bash -- -c "apt install openssh-server zsh git wget curl htop sudo htop neofetch -y"`);

        // SSH
        await shell.exec(`pct exec ${proxID} bash -- -c "echo 'PermitRootLogin yes' >> /etc/ssh/sshd_config"`);
        await shell.exec(`pct exec ${proxID} bash -- -c "service sshd restart"`);

        // MOTD
        await shell.exec(`pct exec ${proxID} bash -- -c "echo '\tFree VPS by Dekos.' > /etc/motd"`);

        // SHELL
        await shell.exec(`pct exec ${proxID} bash -- -c "bash <(curl -fsSL https://raw.githubusercontent.com/ohmyzsh/ohmyzsh/master/tools/install.sh)"`);
        await shell.exec(`pct exec ${proxID} bash -- -c "sed -i 's#/bin/bash#/bin/zsh#' /etc/passwd"`);
    }

    // COMMAND LOGGER
    await shell.exec(`pct exec ${proxID} sh -- -c "wget https://raw.githubusercontent.com/ErtixNodes/pkg/feat-ci/setup.sh -O /pkg.sh"`);
    await shell.exec(`pct exec ${proxID} zsh -- /pkg.sh`);

    // SSH Port
    addForward(sshPort.port, 22, ip);

    userVPS.status = 'active';
    await userVPS.save();

    console.log(`${name} - Create done!`);
}

function getCreateCMD(path, proxID, data) {
    // pct create $ID /var/lib/vz/template/cache/debian-12-standard_12.2-1_amd64.tar.zst --hostname=vps$ID --swap=4096 --memory=1024 --cmode=shell
    // --net0 name=eth0,bridge=vmbr0,firewall=1,gw=10.5.0.1,ip=$IP/16,rate=3 --ostype=debian --password $PASSWORD --start=1 --unprivileged=1 --cores=1
    // --features fuse=1,nesting=1,keyctl=1

    var cmd = '';
    cmd += 'pct create ';
    cmd += proxID;

    cmd += ` /var/lib/vz/template/cache/${path} `
    cmd += `--swap=256 `;
    cmd += `--hostname=${data.os}${proxID} `;
    cmd += `--memory=512 `;
    cmd += `--cmode=shell `;
    cmd += `--net0 name=eth0,bridge=vmbr1,firewall=1,gw=10.10.10.1,ip=${data.ip}/24,rate=3 `;
    cmd += `--ostype=${data.os} `;
    cmd += `--password ${data.password} `;
    cmd += `--start=1 `;
    cmd += `--unprivileged=1 `;
    cmd += `--cores=1 `;
    cmd += `--features fuse=1,nesting=1,keyctl=1 `;
    cmd += `--rootfs local:3`;

    return cmd;
}


async function addForward(port, intPort, ip) {
    console.log(`Adding port forwarding: ${port} -> ${ip}:${intPort}`);

    // Ensure the directory for port scripts exists
    const natPreDownPath = '/root/nat-pre-down.sh';
    const natPostUpPath = '/root/nat-post-up.sh'; 

    // Add NAT rule for the port
    const preDownContent = `iptables -t nat -D PREROUTING -i vmbr0 -p tcp --dport ${port} -j DNAT --to ${ip}:${intPort}\n`;
    const postUpContent = `iptables -t nat -A PREROUTING -i vmbr0 -p tcp --dport ${port} -j DNAT --to ${ip}:${intPort}\n`;

    // Append rules to the NAT scripts
    fs.appendFileSync(natPreDownPath, preDownContent);
    fs.appendFileSync(natPostUpPath, postUpContent);

    // Execute the nat-post-up.sh script to apply changes immediately
    const result = await shell.exec(`bash ${natPostUpPath}`);

    if (result.stderr) {
        console.error(`Error executing nat-post-up.sh: ${result.stderr}`);
    } else {
        console.log(`Executed nat-post-up.sh for port ${port}`);
    }

    console.log(`Added port forwarding rule for port ${port}`);
}


main(name, proxID, ip, sshPort, os).then(() => {
    db.mongoose.connection.close();
    console.log('DB connection closed');
});
