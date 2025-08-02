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
        this.javaInstalled = true;
        this.restartAttempts = 0;
        this.downloadQueue = []; // Queue downloads to reduce simultaneous CPU load

        this.setupExpress();
        this.setupRoutes();
        this.setupServerProperties();
        this.getPublicIP();

        // Stagger initialization to reduce startup CPU load
        if (this.isKoyeb) {
            setTimeout(() => {
                this.downloadRequiredFiles().catch(error => {
                    console.error('❌ Failed to download required files:', error.message);
                });
            }, 2000); // Delay download by 2 seconds
        }
    }

    getLocalIP() {
        try {
            const interfaces = os.networkInterfaces();
            for (const name of Object.keys(interfaces)) {
                for (const networkInterface of interfaces[name]) {
                    if (networkInterface.family === 'IPv4' && !networkInterface.internal) {
                        return networkInterface.address;
                    }
                }
            }
        } catch (error) {
            console.log('⚠️  Error detecting local IP:', error.message);
        }
        return this.isKoyeb ? '0.0.0.0' : 'localhost';
    }

    async getPublicIP() {
        try {
            // For production, try environment variable first
            if (process.env.KOYEB_PUBLIC_DOMAIN) {
                this.publicIP = process.env.KOYEB_PUBLIC_DOMAIN;
                console.log(`🌐 Public Domain: ${this.publicIP}`);
                return;
            }

            // Only fetch external IP if needed, with timeout
            const https = require('https');
            const options = {
                hostname: 'api.ipify.org',
                port: 443,
                path: '/',
                method: 'GET',
                timeout: 5000 // 5 second timeout to prevent hanging
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
                console.log('⚠️  Could not detect public IP:', error.message);
                this.publicIP = this.isKoyeb ? 'production-server' : 'localhost';
            });

            req.on('timeout', () => {
                req.destroy();
                this.publicIP = this.isKoyeb ? 'production-server' : 'localhost';
            });

            req.end();
        } catch (error) {
            this.publicIP = this.isKoyeb ? 'production-server' : 'localhost';
        }
    }

    // Sequential download to reduce CPU load
    async downloadRequiredFiles() {
        console.log('📥 Downloading server files sequentially to reduce CPU load...');

        if (!fs.existsSync(this.serverPath)) {
            fs.mkdirSync(this.serverPath, { recursive: true });
        }

        if (!fs.existsSync(path.join(this.serverPath, 'plugins'))) {
            fs.mkdirSync(path.join(this.serverPath, 'plugins'), { recursive: true });
        }

        try {
            // Download files one by one to reduce CPU load
            console.log('📥 Step 1/5: Downloading Paper server...');
            await this.downloadFile(
                'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/497/downloads/paper-1.20.4-497.jar',
                path.join(this.serverPath, this.jarFile),
                'Paper Server'
            );

            // Small delay between downloads
            await this.sleep(1000);

            console.log('📥 Step 2/5: Downloading Geyser (priority)...');
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'Geyser-Spigot.jar'),
                'Geyser Plugin'
            );

            await this.sleep(1000);

            console.log('📥 Step 3/5: Downloading Floodgate...');
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'floodgate-spigot.jar'),
                'Floodgate Plugin'
            );

            // Optional plugins - only download if CPU load is manageable
            console.log('📥 Step 4/5: Downloading ViaVersion (optional)...');
            try {
                await this.downloadFile(
                    'https://hangar.papermc.io/api/v1/projects/ViaVersion/versions/5.4.1/PAPER/download',
                    path.join(this.serverPath, 'plugins', 'ViaVersion.jar'),
                    'ViaVersion Plugin'
                );

                await this.sleep(1000);

                console.log('📥 Step 5/5: Downloading ViaBackwards (optional)...');
                await this.downloadFile(
                    'https://hangar.papermc.io/api/v1/projects/ViaBackwards/versions/5.3.2/PAPER/download',
                    path.join(this.serverPath, 'plugins', 'ViaBackwards.jar'),
                    'ViaBackwards Plugin'
                );
            } catch (error) {
                console.log('⚠️  Skipping optional plugins due to download issues');
            }

            console.log('✅ All server files downloaded successfully');
        } catch (error) {
            console.error('❌ Error downloading files:', error.message);
        }
    }

    // Helper function for delays
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
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
                const request = client.get(url, {
                    timeout: 30000 // 30 second timeout
                }, (response) => {
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

                request.on('timeout', () => {
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
        this.app.use(express.json({ limit: '1mb' })); // Limit JSON payload size
        this.app.use(express.static('public', {
            maxAge: '1d', // Cache static files
            etag: false // Disable ETags to reduce CPU
        }));

        // Only add CORS if the module exists
        try {
            const cors = require('cors');
            this.app.use(cors({
                origin: false, // Disable CORS preflight to reduce requests
                credentials: false
            }));
        } catch (error) {
            console.log('⚠️  CORS module not found, skipping...');
        }

        // Lightweight health check
        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                server: this.serverStatus,
                timestamp: Date.now()
            });
        });
    }

    setupRoutes() {
        // Serve the main page with error handling
        this.app.get('/', (req, res) => {
            try {
                const indexPath = path.join(__dirname, 'public', 'index.html');
                if (fs.existsSync(indexPath)) {
                    res.sendFile(indexPath);
                } else {
                    res.send('<h1>Minecraft Crossplay Server</h1><p>Server is running!</p>');
                }
            } catch (error) {
                res.send('<h1>Minecraft Crossplay Server</h1><p>Server is running!</p>');
            }
        });

        // Optimized status endpoint
        this.app.get('/status', (req, res) => {
            const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
            res.json({
                status: this.serverStatus,
                running: this.minecraftProcess !== null,
                ready: this.serverReady,
                uptime: uptime,
                publicIP: this.publicIP,
                javaPort: this.javaPort,
                bedrockPort: this.bedrockPort,
                connections: {
                    java: `${this.publicIP}:${this.javaPort}`,
                    bedrock: `${this.publicIP}:${this.bedrockPort}`
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
            if (this.serverStatus !== 'online' || !command) {
                return res.json({
                    success: false,
                    message: 'Server must be online and command must be provided'
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

        // Ultra CPU-optimized server properties
        const properties = `
server-ip=0.0.0.0
server-port=${this.javaPort}
gamemode=survival
difficulty=easy
max-players=8
motd=§aCrossplay Server §7| §eOptimized §7| §bLow CPU
server-name=OptimizedCrossplayServer
online-mode=false
enforce-whitelist=false

# CPU Optimization Settings
view-distance=4
simulation-distance=3
max-tick-time=60000
entity-activation-range.animals=16
entity-activation-range.monsters=24
entity-activation-range.raiders=32
entity-activation-range.misc=8
tick-inactive-villagers=false

# Reduce server calculations
max-auto-save-chunks-per-tick=4
auto-save-interval=6000
max-world-size=5000

# Network optimizations
network-compression-threshold=256
enable-query=false
enable-status=true
enable-command-block=false
spawn-protection=0
allow-nether=true
level-name=world
require-resource-pack=false
prevent-proxy-connections=false

# Performance tweaks
use-native-transport=true
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
        console.log('🚀 STARTING OPTIMIZED CROSSPLAY SERVER');
        console.log('='.repeat(60));
        console.log('📡 Status: STARTING...');
        console.log(`🌐 Public IP: ${this.publicIP || 'Detecting...'}`);
        console.log('💾 Memory: Ultra-optimized for low CPU usage');
        console.log('⏳ Please wait while server initializes...');
        console.log('='.repeat(60));

        // Ultra CPU-optimized JVM arguments
        const javaArgs = [
            '-Xmx320M',                    // Reduced max memory
            '-Xms128M',                    // Small initial memory
            '-XX:+UseSerialGC',            // Least CPU-intensive GC
            '-XX:MaxGCPauseMillis=1000',   // Allow longer pauses, less frequent GC
            '-XX:+DisableExplicitGC',      // Disable manual GC calls
            '-XX:+UseCompressedOops',      // Memory efficiency
            '-XX:+OptimizeStringConcat',   // String optimization
            '-Xss256k',                    // Smaller stack size
            '-XX:CompileThreshold=1500',   // Delay JIT compilation
            '-Djava.awt.headless=true',
            '-Dfile.encoding=UTF-8',
            '-Dpaper.playerconnection.keepalive=60', // Reduce network overhead
            '-jar',
            this.jarFile,
            'nogui'
        ];

        console.log('💾 JVM Settings: Max 320MB, Serial GC, CPU-optimized');

        this.minecraftProcess = spawn('java', javaArgs, {
            cwd: this.serverPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                JAVA_HOME: '/usr/lib/jvm/java-21-openjdk',
                // Limit Java to use fewer CPU cores
                _JAVA_OPTIONS: '-XX:ActiveProcessorCount=1'
            }
        });

        this.minecraftProcess.stdout.on('data', (data) => {
            const message = data.toString().trim();
            console.log(`[MC]: ${message}`);

            // Check for server ready state
            if (message.includes('Done (') && message.includes('For help, type "help"')) {
                this.serverStatus = 'online';
                this.serverReady = true;
                this.restartAttempts = 0;
                console.log('\n' + '🎉'.repeat(20));
                console.log('✅ OPTIMIZED SERVER IS NOW ONLINE!');
                console.log('🎉'.repeat(20));
                setTimeout(() => this.displayConnectionInfo(), 1000); // Delay to reduce CPU spike
            }

            // Check for plugin startup (less verbose)
            if (message.includes('Geyser') && message.includes('Started')) {
                console.log('🔗 Crossplay bridge (Geyser) is ONLINE!');
            }
        });

        this.minecraftProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            // Only log important errors to reduce CPU load
            if (error.includes('ERROR') || error.includes('FATAL')) {
                console.error(`[MC ERROR]: ${error}`);
            }
        });

        this.minecraftProcess.on('error', (error) => {
            console.error(`❌ Failed to start Minecraft server:`, error.message);
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

                // Reduced restart attempts and longer delays
                if (this.restartAttempts < 2) {
                    this.restartAttempts++;
                    console.log(`🔄 Auto-restarting in 30 seconds... (attempt ${this.restartAttempts}/2)`);
                    setTimeout(() => {
                        this.startMinecraftServer();
                    }, 30000); // Longer delay between restarts
                } else {
                    console.log('❌ Maximum restart attempts reached. Server will remain offline.');
                }
            } else {
                console.log('✅ Server stopped normally.');
                this.restartAttempts = 0;
            }
        });
    }

    displayConnectionInfo() {
        console.log('\n' + '='.repeat(60));
        console.log('🎮 MINECRAFT CROSSPLAY SERVER IS ONLINE! 🎮');
        console.log('='.repeat(60));

        if (this.publicIP && this.publicIP !== 'Unable to detect') {
            console.log('\n📋 SHARE WITH FRIENDS:');
            console.log(`   Java Edition: ${this.publicIP}:${this.javaPort}`);
            console.log(`   Bedrock Edition: ${this.publicIP}:${this.bedrockPort}`);
            console.log('   ✅ No port forwarding needed!');
        }

        console.log('\n🎯 SUPPORTED VERSIONS:');
        console.log('   📱 Java Edition: 1.20+ (optimized)');
        console.log('   🎮 Bedrock Edition: All platforms');
        console.log('='.repeat(60) + '\n');
    }

    stopMinecraftServer() {
        if (this.minecraftProcess) {
            this.serverStatus = 'stopping';
            console.log('\n⏹️  Stopping Minecraft server...');

            try {
                this.minecraftProcess.stdin.write('stop\n');
            } catch (error) {
                console.log('⚠️  Error sending stop command, forcing shutdown...');
                this.minecraftProcess.kill('SIGTERM');
            }

            // Shorter timeout for force kill
            setTimeout(() => {
                if (this.minecraftProcess) {
                    console.log('⚠️  Force stopping server...');
                    this.minecraftProcess.kill('SIGKILL');
                }
            }, 15000); // Reduced from 30 seconds
        }
    }

    executeCommand(command) {
        if (this.minecraftProcess && this.serverReady && command && command.length < 100) {
            try {
                this.minecraftProcess.stdin.write(`${command}\n`);
                console.log(`[COMMAND]: ${command}`);
            } catch (error) {
                console.log('⚠️  Error executing command:', error.message);
            }
        }
    }

    start(port) {
        const finalPort = port || this.webPort;

        // Graceful shutdown handlers
        process.on('SIGTERM', () => {
            console.log('📡 Received SIGTERM. Gracefully shutting down...');
            this.stopMinecraftServer();
            setTimeout(() => process.exit(0), 5000); // Give 5 seconds for cleanup
        });

        process.on('SIGINT', () => {
            console.log('📡 Received SIGINT. Gracefully shutting down...');
            this.stopMinecraftServer();
            setTimeout(() => process.exit(0), 5000);
        });

        this.app.listen(finalPort, '0.0.0.0', (err) => {
            if (err) {
                console.error('❌ Failed to start web server:', err);
                process.exit(1);
            }

            console.log(`🚀 Minecraft Server Manager running on port ${finalPort}`);
            console.log(`⚡ CPU-optimized deployment`);
            console.log(`🌐 Public URL will be available after deployment`);
            console.log('='.repeat(50));
        });
    }
}

const manager = new MinecraftCrossplayServer();
manager.start();
