const dayjs = require('dayjs');

async function handle(req, res) {
    const { db } = req;

    res.type('txt');

    var user = await db.User.findOne({
        userID: req.session.user.id
    });
    var vps = await db.VPS.findOne({
        userID: req.session.user.id,
        proxID: req.params.id
    });
    if (!vps) return res.send('UNKNOWN');

    const { sure } = req.query;
    if (!sure || sure != 'yes') return res.send('UNKNOWN');

    vps.expiry = Date.now();
    vps.status = 'error';
    await vps.save();

    req.hook.send(`<@${process.env.ADMIN_ID}> :orange_square: **DELETE** - <@${req.session.userID}> ${vps.name}`);

    res.redirect(`/dash`);
}

module.exports = handle;