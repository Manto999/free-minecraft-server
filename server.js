const express = require('express');
const { spawn, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

class MinecraftCrossplayServer {
    constructor() {
        this.app = express();
        this.minecraftProcess = null;
        this.serverPath = './minecraft-server';
        this.jarFile = 'paper-server.jar';

        // Use environment variables for deployment
        this.javaPort = process.env.MINECRAFT_PORT || 25565;
        this.bedrockPort = process.env.BEDROCK_PORT || 19132;
        this.webPort = process.env.PORT || 3000;

        this.localIP = this.getLocalIP();
        this.publicIP = null;
        this.serverStatus = 'offline';
        this.startTime = null;
        this.serverReady = false;
        this.isKoyeb = process.env.NODE_ENV === 'production';
        this.javaInstalled = true; // Docker ensures Java is available
        this.restartAttempts = 0; // Track restart attempts

        this.setupExpress();
        this.setupRoutes();
        this.setupServerProperties();
        this.getPublicIP();

        // Download required files for cloud deployment
        if (this.isKoyeb) {
            this.downloadRequiredFiles().catch(error => {
                console.error('❌ Failed to download required files:', error.message);
            });
        }
    }

    getLocalIP() {
        const interfaces = os.networkInterfaces();
        for (const name of Object.keys(interfaces)) {
            for (const networkInterface of interfaces[name]) {
                if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
                    return networkInterface.address;
                }
            }
        }
        return this.isKoyeb ? '0.0.0.0' : 'localhost';
    }

    async getPublicIP() {
        try {
            // For Koyeb, try to get the public domain from environment
            if (process.env.KOYEB_PUBLIC_DOMAIN) {
                this.publicIP = process.env.KOYEB_PUBLIC_DOMAIN;
                console.log(`🌐 Koyeb Public Domain: ${this.publicIP}`);
                return;
            }

            const https = require('https');
            const options = {
                hostname: 'api.ipify.org',
                port: 443,
                path: '/',
                method: 'GET'
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    this.publicIP = data.trim();
                    console.log(`🌐 Public IP detected: ${this.publicIP}`);
                });
            });

            req.on('error', (error) => {
                console.log('Could not detect public IP:', error.message);
                this.publicIP = this.isKoyeb ? 'koyeb-app.com' : 'Unable to detect';
            });

            req.end();
        } catch (error) {
            this.publicIP = this.isKoyeb ? 'koyeb-app.com' : 'Unable to detect';
        }
    }

    async downloadRequiredFiles() {
        console.log('📥 Downloading required server files for cloud deployment...');

        if (!fs.existsSync(this.serverPath)) {
            fs.mkdirSync(this.serverPath, { recursive: true });
        }

        if (!fs.existsSync(path.join(this.serverPath, 'plugins'))) {
            fs.mkdirSync(path.join(this.serverPath, 'plugins'), { recursive: true });
        }

        try {
            // Download Paper server
            await this.downloadFile(
                'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/497/downloads/paper-1.20.4-497.jar',
                path.join(this.serverPath, this.jarFile),
                'Paper Server'
            );

            // Download ViaVersion for multi-version support
            await this.downloadFile(
                'https://hangar.papermc.io/api/v1/projects/ViaVersion/versions/5.4.1/PAPER/download',
                path.join(this.serverPath, 'plugins', 'ViaVersion.jar'),
                'ViaVersion Plugin'
            );

            // Download ViaBackwards for older version support
            await this.downloadFile(
                'https://hangar.papermc.io/api/v1/projects/ViaBackwards/versions/5.3.2/PAPER/download',
                path.join(this.serverPath, 'plugins', 'ViaBackwards.jar'),
                'ViaBackwards Plugin'
            );

            // Download Geyser for Bedrock crossplay
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'Geyser-Spigot.jar'),
                'Geyser Plugin'
            );

            // Download Floodgate for Bedrock authentication
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'floodgate-spigot.jar'),
                'Floodgate Plugin'
            );

            console.log('✅ All server files downloaded successfully');
        } catch (error) {
            console.error('❌ Error downloading files:', error.message);
        }
    }

    async downloadFile(url, filepath, description) {
        if (fs.existsSync(filepath)) {
            console.log(`⏭️  Skipping ${description} - already exists`);
            return;
        }

        try {
            console.log(`📥 Downloading ${description}...`);
            const https = require('https');
            const http = require('http');

            const file = fs.createWriteStream(filepath);
            const client = url.startsWith('https') ? https : http;

            return new Promise((resolve, reject) => {
                const request = client.get(url, (response) => {
                    // Handle redirects
                    if (response.statusCode === 302 || response.statusCode === 301) {
                        file.close();
                        if (fs.existsSync(filepath)) {
                            fs.unlinkSync(filepath);
                        }
                        return this.downloadFile(response.headers.location, filepath, description)
                            .then(resolve)
                            .catch(reject);
                    }

                    if (response.statusCode !== 200) {
                        file.close();
                        if (fs.existsSync(filepath)) {
                            fs.unlinkSync(filepath);
                        }
                        reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                        return;
                    }

                    response.pipe(file);

                    file.on('finish', () => {
                        file.close();
                        console.log(`✅ Downloaded ${description}`);
                        resolve();
                    });

                    file.on('error', (err) => {
                        file.close();
                        if (fs.existsSync(filepath)) {
                            fs.unlinkSync(filepath);
                        }
                        reject(err);
                    });
                });

                request.on('error', (err) => {
                    file.close();
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                    reject(err);
                });

                request.setTimeout(60000, () => {
                    request.destroy();
                    file.close();
                    if (fs.existsSync(filepath)) {
                        fs.unlinkSync(filepath);
                    }
                    reject(new Error('Download timeout'));
                });
            });
        } catch (error) {
            console.error(`❌ Error downloading ${description}:`, error.message);
            throw error;
        }
    }

    setupExpress() {
        this.app.use(express.json());
        this.app.use(express.static('public'));

        // Add CORS middleware
        const cors = require('cors');
        this.app.use(cors());

        // Health check endpoint for Koyeb
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                server: this.serverStatus,
                java: this.javaInstalled,
                timestamp: Date.now()
            });
        });
    }

    setupRoutes() {
        // Serve the main page
        this.app.get('/', (req, res) => {
            res.sendFile(path.join(__dirname, 'public', 'index.html'));
        });

        this.app.get('/status', (req, res) => {
            const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
            res.json({
                status: this.serverStatus,
                running: this.minecraftProcess !== null,
                ready: this.serverReady,
                uptime: uptime,
                localIP: this.localIP,
                publicIP: this.publicIP,
                javaPort: this.javaPort,
                bedrockPort: this.bedrockPort,
                isKoyeb: this.isKoyeb,
                javaInstalled: this.javaInstalled,
                connections: {
                    local: {
                        java: `localhost:${this.javaPort}`,
                        bedrock: `localhost:${this.bedrockPort}`
                    },
                    network: {
                        java: `${this.localIP}:${this.javaPort}`,
                        bedrock: `${this.localIP}:${this.bedrockPort}`
                    },
                    internet: this.publicIP !== 'Unable to detect' ? {
                        java: `${this.publicIP}:${this.javaPort}`,
                        bedrock: `${this.publicIP}:${this.bedrockPort}`,
                        note: this.isKoyeb ? "Hosted on Koyeb - Direct connection" : "Port forwarding required"
                    } : null
                }
            });
        });

        this.app.post('/start', (req, res) => {
            if (this.serverStatus === 'starting' || this.serverStatus === 'online') {
                return res.json({
                    success: false,
                    message: 'Server is already starting or running'
                });
            }

            this.startMinecraftServer();
            res.json({
                success: true,
                message: 'Server is starting...',
                status: 'starting'
            });
        });

        this.app.post('/stop', (req, res) => {
            if (this.serverStatus === 'offline') {
                return res.json({
                    success: false,
                    message: 'Server is already offline'
                });
            }

            this.stopMinecraftServer();
            res.json({
                success: true,
                message: 'Server is stopping...',
                status: 'stopping'
            });
        });

        this.app.post('/command', (req, res) => {
            const { command } = req.body;
            if (this.serverStatus !== 'online') {
                return res.json({
                    success: false,
                    message: 'Server must be online to send commands'
                });
            }

            this.executeCommand(command);
            res.json({
                success: true,
                message: `Command executed: ${command}`
            });
        });
    }

    setupServerProperties() {
        const propertiesPath = path.join(this.serverPath, 'server.properties');
        const properties = `
server-ip=0.0.0.0
server-port=${this.javaPort}
gamemode=survival
difficulty=easy
max-players=15
motd=§aCrossplay Server §7| §eDocker Hosted §7| §bALL VERSIONS
server-name=DockerCrossplayServer
online-mode=false
enforce-whitelist=false
view-distance=8
simulation-distance=6
enable-query=true
query.port=${this.javaPort}
level-name=world
allow-nether=true
enable-command-block=true
spawn-protection=0
require-resource-pack=false
prevent-proxy-connections=false
        `.trim();

        if (!fs.existsSync(this.serverPath)) {
            fs.mkdirSync(this.serverPath, { recursive: true });
        }

        fs.writeFileSync(propertiesPath, properties);

        const eulaPath = path.join(this.serverPath, 'eula.txt');
        fs.writeFileSync(eulaPath, 'eula=true');
    }

    async startMinecraftServer() {
        if (this.minecraftProcess) {
            console.log('⚠️  Server already running');
            return;
        }

        this.serverStatus = 'starting';
        this.serverReady = false;
        this.startTime = Date.now();

        console.log('\n' + '='.repeat(60));
        console.log('🚀 STARTING DOCKER MINECRAFT CROSSPLAY SERVER');
        console.log('='.repeat(60));
        console.log('📡 Status: STARTING...');
        console.log(`🏠 Local IP: ${this.localIP}`);
        console.log(`🌐 Public IP: ${this.publicIP || 'Detecting...'}`);
        console.log('🐳 Running in Docker Container');
        console.log('⏳ Please wait while server initializes...');
        console.log('='.repeat(60));

        const javaArgs = [
            '-Xmx384M',                    // Maximum 384MB (reduced)
            '-Xms128M',                    // Initial 128MB (reduced)
            '-XX:+UseSerialGC',            // Serial GC uses less memory
            '-XX:MaxGCPauseMillis=500',
            '-XX:+DisableExplicitGC',
            '-XX:+UseCompressedOops',      // Compress object pointers
            '-XX:+OptimizeStringConcat',   // Optimize string operations
            '-Dfile.encoding=UTF-8',
            '-Djava.awt.headless=true',    // Headless mode
            '-jar',
            this.jarFile,
            'nogui'
        ];

        this.minecraftProcess = spawn('java', javaArgs, {
            cwd: this.serverPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, JAVA_HOME: '/usr/lib/jvm/java-21-openjdk' }
        });

        this.minecraftProcess.stdout.on('data', (data) => {
            const message = data.toString().trim();
            console.log(`[MC]: ${message}`);

            // Check for server ready state
            if (message.includes('Done (') && message.includes('For help, type "help"')) {
                this.serverStatus = 'online';
                this.serverReady = true;
                this.restartAttempts = 0; // Reset restart attempts on successful start
                console.log('\n' + '🎉'.repeat(20));
                console.log('✅ DOCKER SERVER IS NOW ONLINE!');
                console.log('🎉'.repeat(20));
                this.displayConnectionInfo();
            }

            // Check for Geyser startup
            if (message.includes('Geyser') && message.includes('Started Geyser')) {
                console.log('🔗 Crossplay bridge (Geyser) is ONLINE!');
            }

            // Check for ViaVersion startup
            if (message.includes('ViaVersion') && message.includes('enabled')) {
                console.log('🔄 Multi-version support (ViaVersion) is ONLINE!');
            }
        });

        this.minecraftProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            console.error(`[MC ERROR]: ${error}`);
        });

        this.minecraftProcess.on('error', (error) => {
            console.error(`❌ Failed to start Minecraft server:`, error.message);
            if (error.code === 'ENOENT') {
                console.error('💡 Java not found. Make sure Java is installed and in PATH.');
            }
            this.serverStatus = 'offline';
            this.serverReady = false;
            this.startTime = null;
        });

        this.minecraftProcess.on('close', (code) => {
            console.log(`\n⏹️  Minecraft server exited with code ${code}`);
            this.minecraftProcess = null;
            this.serverStatus = 'offline';
            this.serverReady = false;
            this.startTime = null;

            if (code !== 0) {
                console.log('💥 Server crashed! Check the error messages above.');

                // Auto-restart on crash (limited attempts)
                if (this.restartAttempts < 3) {
                    this.restartAttempts++;
                    console.log(`🔄 Auto-restarting in 15 seconds... (attempt ${this.restartAttempts}/3)`);
                    setTimeout(() => {
                        this.startMinecraftServer();
                    }, 15000);
                } else {
                    console.log('❌ Maximum restart attempts reached. Server will remain offline.');
                }
            } else {
                console.log('✅ Server stopped normally.');
                this.restartAttempts = 0; // Reset on normal shutdown
            }
        });
    }

    displayConnectionInfo() {
        console.log('\n' + '='.repeat(70));
        console.log('🎮 MINECRAFT CROSSPLAY SERVER IS ONLINE! (DOCKER) 🎮');
        console.log('='.repeat(70));

        console.log('\n📱 JAVA EDITION CONNECTIONS:');
        if (this.publicIP && this.publicIP !== 'Unable to detect') {
            console.log(`   🌐 Internet: ${this.publicIP}:${this.javaPort}`);
        }

        console.log('\n🎯 BEDROCK EDITION CONNECTIONS:');
        if (this.publicIP && this.publicIP !== 'Unable to detect') {
            console.log(`   🌐 Internet: ${this.publicIP}:${this.bedrockPort}`);
        }

        console.log(`\n🌐 Management Panel: https://${this.publicIP}`);

        console.log('\n📋 SHARE WITH FRIENDS (KOYEB HOSTED):');
        console.log(`   Java Edition: ${this.publicIP}:${this.javaPort}`);
        console.log(`   Bedrock Edition: ${this.publicIP}:${this.bedrockPort}`);
        console.log('   ✅ No port forwarding needed!');

        console.log('\n🎯 SUPPORTED VERSIONS:');
        console.log('   📱 Java Edition: 1.8.x to 1.21.x (ALL VERSIONS)');
        console.log('   🎮 Bedrock Edition: Mobile, Console, Windows 10');
        console.log('='.repeat(70) + '\n');
    }

    stopMinecraftServer() {
        if (this.minecraftProcess) {
            this.serverStatus = 'stopping';
            console.log('\n⏹️  Stopping Minecraft server...');
            this.minecraftProcess.stdin.write('stop\n');

            // Force kill after 30 seconds if graceful shutdown fails
            setTimeout(() => {
                if (this.minecraftProcess) {
                    console.log('⚠️  Force stopping server...');
                    this.minecraftProcess.kill('SIGTERM');
                }
            }, 30000);
        }
    }

    executeCommand(command) {
        if (this.minecraftProcess && this.serverReady && command) {
            this.minecraftProcess.stdin.write(`${command}\n`);
            console.log(`[COMMAND]: ${command}`);
        }
    }

    start(port) {
        const finalPort = port || this.webPort;

        // Handle graceful shutdown
        process.on('SIGTERM', () => {
            console.log('📡 Received SIGTERM. Gracefully shutting down...');
            this.stopMinecraftServer();
            process.exit(0);
        });

        process.on('SIGINT', () => {
            console.log('📡 Received SIGINT. Gracefully shutting down...');
            this.stopMinecraftServer();
            process.exit(0);
        });

        this.app.listen(finalPort, '0.0.0.0', (err) => {
            if (err) {
                console.error('❌ Failed to start web server:', err);
                process.exit(1);
            }

            console.log(`🚀 Minecraft Server Manager running on port ${finalPort}`);
            console.log(`🐳 Docker deployment detected`);
            console.log(`🌐 Public URL will be available after deployment`);
            console.log('='.repeat(50));
        });
    }
}

const manager = new MinecraftCrossplayServer();
manager.start();
