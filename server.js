require('dotenv').config();
const express = require('express');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

// Reads token
const token = process.env.DISCORD_TOKEN;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildBans,
        GatewayIntentBits.GuildPresences
    ]
});

app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false
}));

// Load auto-responses
let autoResponses = [];
try {
    const autoResponseData = fs.readFileSync(path.join(__dirname, 'autoresponds.json'), 'utf8');
    autoResponses = JSON.parse(autoResponseData).autoResponses;
} catch (error) {
    console.error('Error loading auto-responses:', error);
}

// Save auto-responses
function saveAutoResponses() {
    try {
        fs.writeFileSync(
            path.join(__dirname, 'autoresponds.json'),
            JSON.stringify({ autoResponses }, null, 4)
        );
    } catch (error) {
        console.error('Error saving auto-responses:', error);
    }
}

app.get('/', (req, res) => {
    res.render('index', { 
        bot: client.user ? {
            id: client.user.id,
            tag: client.user.tag,
            avatar: client.user.avatar
        } : null 
    });
});

app.get('/messages', (req, res) => {
    res.render('messages', { 
        bot: client.user ? {
            id: client.user.id,
            tag: client.user.tag,
            avatar: client.user.avatar
        } : null 
    });
});

app.get('/settings', (req, res) => {
    res.render('settings', { 
        bot: client.user ? {
            id: client.user.id,
            tag: client.user.tag,
            avatar: client.user.avatar
        } : null 
    });
});

app.get('/servers', async (req, res) => {
    const guilds = client.guilds.cache.map(guild => ({
        id: guild.id,
        name: guild.name,
        memberCount: guild.memberCount,
        icon: guild.iconURL()
    }));
    res.render('servers', { guilds, bot: client.user });
});

app.get('/server/:id', async (req, res) => {
    const guild = client.guilds.cache.get(req.params.id);
    if (!guild) return res.redirect('/servers');
    
    const channels = guild.channels.cache
        .filter(channel => channel.type === 0)
        .map(channel => ({
            id: channel.id,
            name: channel.name
        }));
    
    res.render('server', { guild, channels, bot: client.user });
});

io.on('connection', (socket) => {
    const totalServers = client.guilds.cache.size;
    const totalMembers = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
    socket.emit('stats-update', {
        servers: totalServers,
        members: totalMembers > 99 ? '99+' : totalMembers
    });

    socket.emit('server-list', client.guilds.cache.map(guild => ({
        id: guild.id,
        name: guild.name
    })));

    socket.emit('current-settings', {
        activityType: 'PLAYING',
        activityText: '@mkl.08 / @pomcodes',
        prefix: '!',
        notifications: {
            newMessage: true,
            memberUpdates: true,
            serverUpdates: true
        },
        autoResponses
    });

    socket.on('get-channels', async (data) => {
        try {
            const guild = await client.guilds.fetch(data.serverId);
            if (guild) {
                const channels = guild.channels.cache
                    .filter(channel => channel.type === 0)
                    .map(channel => ({
                        id: channel.id,
                        name: channel.name
                    }));
                socket.emit('channel-list', channels);
            }
        } catch (error) {
            console.error('Error getting channels:', error);
        }
    });

    socket.on('get-messages', async ({ channelId }) => {
        try {
            const channel = await client.channels.fetch(channelId);
            if (!channel) {
                socket.emit('message-list', []);
                return;
            }

            const messages = await channel.messages.fetch({ limit: 50 });
            const messageList = Array.from(messages.values()).map(msg => ({
                content: msg.content,
                author: msg.author.tag,
                timestamp: msg.createdTimestamp
            }));

            socket.emit('message-list', messageList);
        } catch (error) {
            console.error('Error fetching messages:', error);
            socket.emit('message-list', []);
        }
    });

    socket.on('get-dms', async () => {
        try {
            const users = await Promise.all(
                client.guilds.cache.flatMap(guild => 
                    guild.members.cache
                        .filter(member => !member.user.bot)
                        .map(member => member.user)
                )
            );

            const uniqueUsers = Array.from(new Set(users.map(user => user.id)))
                .map(id => {
                    const user = users.find(u => u.id === id);
                    return {
                        id: user.id,
                        username: user.tag,
                        avatar: user.avatar
                    };
                });

            socket.emit('dm-list', uniqueUsers);
        } catch (error) {
            console.error('Error fetching DMs:', error);
        }
    });

    socket.on('get-dm-messages', async (data) => {
        try {
            const user = await client.users.fetch(data.userId);
            const dmChannel = await user.createDM();
            const messages = await dmChannel.messages.fetch({ limit: 50 });
            
            socket.emit('message-list', Array.from(messages.values()).map(msg => ({
                id: msg.id,
                content: msg.content,
                author: msg.author.tag,
                timestamp: msg.createdTimestamp
            })));
        } catch (error) {
            console.error('Error fetching DM messages:', error);
        }
    });

    socket.on('send-dm', async (data) => {
        try {
            const user = await client.users.fetch(data.userId);
            const dmChannel = await user.createDM();
            await dmChannel.send(data.message);
        } catch (error) {
            console.error('Error sending DM:', error);
        }
    });

    socket.on('get-servers', () => {
        const servers = client.guilds.cache.map(guild => ({
            id: guild.id,
            name: guild.name
        }));
        socket.emit('server-list', servers);
    });

    socket.on('update-activity', async (data) => {
        try {
            await client.user.setActivity(data.text, { type: ActivityType[data.type] });
            socket.emit('activity-updated', { success: true });
        } catch (error) {
            socket.emit('activity-updated', { success: false, error: error.message });
        }
    });

    socket.on('update-default-activity', async (data) => {
        try {
            await client.user.setActivity(data.text, { type: ActivityType[data.type] });
            socket.emit('settings-updated', { success: true });
        } catch (error) {
            socket.emit('settings-updated', { success: false, error: error.message });
        }
    });

    socket.on('send-message', async (data) => {
        const channel = client.channels.cache.get(data.channelId);
        if (channel) {
            try {
                await channel.send(data.message);
            } catch (error) {
                console.error('Error sending message:', error);
            }
        }
    });

    socket.on('delete-message', async (data) => {
        const channel = client.channels.cache.get(data.channelId);
        if (channel) {
            try {
                const message = await channel.messages.fetch(data.messageId);
                if (message) await message.delete();
            } catch (error) {
                console.error('Error deleting message:', error);
            }
        }
    });

    socket.on('add-auto-response', (data) => {
        try {
            const newResponse = {
                id: Date.now().toString(),
                trigger: data.trigger,
                response: data.response
            };
            autoResponses.push(newResponse);
            saveAutoResponses();
            socket.emit('settings-updated', { success: true });
            io.emit('current-settings', {
                activityType: 'PLAYING',
                activityText: '@mkl.08 / @pomcodes',
                prefix: '!',
                notifications: {
                    newMessage: true,
                    memberUpdates: true,
                    serverUpdates: true
                },
                autoResponses
            });
        } catch (error) {
            socket.emit('settings-updated', { success: false, error: error.message });
        }
    });

    socket.on('delete-auto-response', (data) => {
        try {
            autoResponses = autoResponses.filter(ar => ar.id !== data.id);
            saveAutoResponses();
            socket.emit('settings-updated', { success: true });
            io.emit('current-settings', {
                activityType: 'PLAYING',
                activityText: '@mkl.08 / @pomcodes',
                prefix: '!',
                notifications: {
                    newMessage: true,
                    memberUpdates: true,
                    serverUpdates: true
                },
                autoResponses
            });
        } catch (error) {
            socket.emit('settings-updated', { success: false, error: error.message });
        }
    });

    socket.on('search-auto-responses', (data) => {
        try {
            const searchTerm = data.trigger.toLowerCase();
            const matches = autoResponses.filter(ar => 
                ar.trigger.toLowerCase().includes(searchTerm)
            );
            socket.emit('search-results', { success: true, results: matches });
        } catch (error) {
            socket.emit('search-results', { success: false, error: error.message });
        }
    });

    socket.on('create-invite', async (data) => {
        const guild = client.guilds.cache.get(data.serverId);
        if (guild) {
            try {
                // invite create
                const channel = guild.channels.cache.find(c => c.type === 0);
                if (channel) {
                    const invite = await channel.createInvite({
                        maxAge: 86400, // 24 hours
                        maxUses: 1 // one-time use
                    });
                    socket.emit('invite-created', { 
                        success: true, 
                        invite: `https://discord.gg/${invite.code}` 
                    });
                } else {
                    socket.emit('invite-created', { 
                        success: false, 
                        error: 'No suitable channel found for invite' 
                    });
                }
            } catch (error) {
                socket.emit('invite-created', { 
                    success: false, 
                    error: error.message 
                });
            }
        }
    });

    socket.on('leave-server', async (data) => {
        const guild = client.guilds.cache.get(data.serverId);
        if (guild) {
            try {
                await guild.leave();
                socket.emit('server-left', { success: true });
            } catch (error) {
                socket.emit('server-left', { 
                    success: false, 
                    error: error.message 
                });
            }
        }
    });

    socket.on('give-admin', async (data) => {
        try {
            const guild = await client.guilds.fetch(data.guildId);
            if (!guild) {
                socket.emit('admin-given', { success: false, error: 'Server not found' });
                return;
            }

            const member = await guild.members.fetch(data.userId);
            if (!member) {
                socket.emit('admin-given', { success: false, error: 'Member not found' });
                return;
            }

            let adminRole = guild.roles.cache.find(role => role.name === 'Bot Admin');
            if (!adminRole) {
                adminRole = await guild.roles.create({
                    name: 'Bot Admin',
                    color: '#FF0000',
                    permissions: ['Administrator']
                });
            }

            await member.roles.add(adminRole);
            socket.emit('admin-given', { success: true });
        } catch (error) {
            console.error('Error giving admin:', error);
            socket.emit('admin-given', { success: false, error: error.message });
        }
    });

    socket.on('kick-member', async (data) => {
        try {
            const guild = await client.guilds.fetch(data.guildId);
            if (!guild) {
                socket.emit('member-kicked', { success: false, error: 'Server not found' });
                return;
            }

            const member = await guild.members.fetch(data.userId);
            if (!member) {
                socket.emit('member-kicked', { success: false, error: 'Member not found' });
                return;
            }

            if (!member.kickable) {
                socket.emit('member-kicked', { success: false, error: 'Cannot kick this member (insufficient permissions)' });
                return;
            }

            await member.kick('Kicked via control panel');
            socket.emit('member-kicked', { success: true });
        } catch (error) {
            console.error('Error kicking member:', error);
            socket.emit('member-kicked', { success: false, error: error.message });
        }
    });

    socket.on('get-all-channel-messages', async (data) => {
        try {
            const channel = client.channels.cache.get(data.channelId);
            if (channel) {
                let messages = [];
                let lastId;
                
                while (true) {
                    const options = { limit: 100 };
                    if (lastId) {
                        options.before = lastId;
                    }
                    
                    const batch = await channel.messages.fetch(options);
                    if (batch.size === 0) break;
                    
                    messages.push(...batch.map(msg => ({
                        id: msg.id,
                        content: msg.content,
                        author: msg.author.tag,
                        timestamp: msg.createdTimestamp
                    })));
                    
                    lastId = batch.last().id;
                    if (batch.size < 100) break;
                }
                
                socket.emit('all-channel-messages', {
                    messages,
                    name: channel.name
                });
            }
        } catch (error) {
            console.error('Error fetching all channel messages:', error);
            socket.emit('error', { message: 'Failed to fetch channel messages' });
        }
    });

    socket.on('get-all-dm-messages', async (data) => {
        try {
            const user = await client.users.fetch(data.userId);
            if (user) {
                const dmChannel = await user.createDM();
                let messages = [];
                let lastId;
                
                while (true) {
                    const options = { limit: 100 };
                    if (lastId) {
                        options.before = lastId;
                    }
                    
                    const batch = await dmChannel.messages.fetch(options);
                    if (batch.size === 0) break;
                    
                    messages.push(...batch.map(msg => ({
                        id: msg.id,
                        content: msg.content,
                        author: msg.author.tag,
                        timestamp: msg.createdTimestamp
                    })));
                    
                    lastId = batch.last().id;
                    if (batch.size < 100) break;
                }
                
                socket.emit('all-dm-messages', {
                    messages,
                    name: user.tag
                });
            }
        } catch (error) {
            console.error('Error fetching all DM messages:', error);
            socket.emit('error', { message: 'Failed to fetch DM messages' });
        }
    });

    socket.on('get-guild-channels', async (data) => {
        try {
            const guild = await client.guilds.fetch(data.guildId);
            if (!guild) {
                socket.emit('guild-channels', { 
                    success: false, 
                    error: 'Server not found or bot does not have access' 
                });
                return;
            }

            const channels = await guild.channels.fetch();
            
            console.log('Channel types:', [...channels.values()].map(c => c.type));
            
            const categories = channels
                .filter(channel => channel.type === 4) 
                .map(category => ({
                    id: category.id,
                    name: category.name
                }))
                .sort((a, b) => a.name.localeCompare(b.name));

            const textChannels = channels
                .filter(channel => channel.type === 0)
                .map(channel => ({
                    id: channel.id,
                    name: channel.name,
                    parentId: channel.parentId,
                    type: 'GUILD_TEXT'
                }));

            console.log('Categories:', categories);
            console.log('Text Channels:', textChannels);

            socket.emit('guild-channels', {
                success: true,
                categories,
                channels: textChannels
            });
        } catch (error) {
            console.error('Error fetching guild channels:', error);
            socket.emit('guild-channels', { 
                success: false, 
                error: 'Failed to fetch server channels: ' + error.message 
            });
        }
    });

    socket.on('get-channel-info', async (data) => {
        try {
            const guild = await client.guilds.fetch(data.guildId);
            if (!guild) {
                socket.emit('channel-info', { 
                    success: false, 
                    error: 'Server not found or bot does not have access' 
                });
                return;
            }

            const channel = await guild.channels.fetch(data.channelId);
            if (!channel) {
                socket.emit('channel-info', { 
                    success: false, 
                    error: 'Channel not found in this server' 
                });
                return;
            }

            if (channel.type !== 0) { 
                socket.emit('channel-info', { 
                    success: false, 
                    error: 'This is not a text channel' 
                });
                return;
            }

            socket.emit('channel-info', {
                success: true,
                channel: {
                    id: channel.id,
                    name: channel.name,
                    type: channel.type
                }
            });
        } catch (error) {
            console.error('Error fetching channel info:', error);
            socket.emit('channel-info', { 
                success: false, 
                error: 'Failed to fetch channel information: ' + error.message 
            });
        }
    });
});

client.on('ready', () => {
    console.log(`Logged in as ${client.user.tag}`);
    client.user.setActivity('@mkl.08 / @pomcodes', { type: ActivityType.Playing });
    io.emit('status-update', 'Online');
});

client.on('guildCreate', (guild) => {
    const totalServers = client.guilds.cache.size;
    const totalMembers = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
    io.emit('stats-update', {
        servers: totalServers,
        members: totalMembers > 99 ? '99+' : totalMembers
    });
});

client.on('guildDelete', (guild) => {
    const totalServers = client.guilds.cache.size;
    const totalMembers = client.guilds.cache.reduce((acc, guild) => acc + guild.memberCount, 0);
    io.emit('stats-update', {
        servers: totalServers,
        members: totalMembers > 99 ? '99+' : totalMembers
    });
});

client.on('disconnect', () => {
    io.emit('status-update', 'Offline');
});

client.on('reconnecting', () => {
    io.emit('status-update', 'Reconnecting...');
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const messageContent = message.content.toLowerCase();
    for (const ar of autoResponses) {
        if (messageContent.includes(ar.trigger.toLowerCase())) {
            try {
                await message.channel.send(ar.response);
            } catch (error) {
                console.error('Error sending auto-response:', error);
            }
            break;
        }
    }

    io.emit('new-message', {
        content: message.content,
        author: message.author.tag,
        channelId: message.channel.id,
        messageId: message.id,
        timestamp: message.createdTimestamp
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    console.log(`Visit: http://localhost:${PORT}`);
    client.login(token);
});
