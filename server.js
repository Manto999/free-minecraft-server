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
        this.isProduction = process.env.NODE_ENV === 'production';
        this.javaInstalled = true;
        this.restartAttempts = 0;
        this.memoryMonitorInterval = null;
        this.initializationComplete = false;

        this.setupExpress();
        this.setupRoutes();
        this.setupServerProperties();
        this.getPublicIP();

        // Start initialization sequence for production
        if (this.isProduction) {
            this.initializeServer();
        }
    }

    async initializeServer() {
        console.log('🔧 Starting server initialization sequence...');

        try {
            // Step 1: Download required files
            await this.downloadRequiredFiles();

            // Step 2: Wait for file system to settle
            await this.sleep(2000);

            // Step 3: Auto-start the Minecraft server
            console.log('🚀 Auto-starting Minecraft server...');
            await this.startMinecraftServer();

            this.initializationComplete = true;
            console.log('✅ Server initialization complete!');
        } catch (error) {
            console.error('❌ Server initialization failed:', error.message);
            this.initializationComplete = true;
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
        return this.isProduction ? '0.0.0.0' : '127.0.0.1';
    }

    async getPublicIP() {
        try {
            // Check for platform-specific environment variables
            if (process.env.RAILWAY_STATIC_URL) {
                this.publicIP = process.env.RAILWAY_STATIC_URL.replace('https://', '').replace('http://', '');
                console.log(`🌐 Railway Domain: ${this.publicIP}`);
                return;
            }

            if (process.env.KOYEB_PUBLIC_DOMAIN) {
                this.publicIP = process.env.KOYEB_PUBLIC_DOMAIN.replace('https://', '').replace('http://', '');
                console.log(`🌐 Koyeb Domain: ${this.publicIP}`);
                return;
            }

            // Fallback to external IP detection
            const https = require('https');
            const options = {
                hostname: 'api.ipify.org',
                port: 443,
                path: '/',
                method: 'GET',
                timeout: 5000
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
                this.publicIP = this.isProduction ? 'production-server' : '127.0.0.1';
            });

            req.on('timeout', () => {
                req.destroy();
                this.publicIP = this.isProduction ? 'production-server' : '127.0.0.1';
            });

            req.end();
        } catch (error) {
            this.publicIP = this.isProduction ? 'production-server' : '127.0.0.1';
        }
    }

    async downloadRequiredFiles() {
        console.log('📥 Downloading required server files for crossplay...');

        if (!fs.existsSync(this.serverPath)) {
            fs.mkdirSync(this.serverPath, { recursive: true });
        }

        if (!fs.existsSync(path.join(this.serverPath, 'plugins'))) {
            fs.mkdirSync(path.join(this.serverPath, 'plugins'), { recursive: true });
        }

        try {
            console.log('📥 Step 1/5: Downloading Paper server...');
            await this.downloadFile(
                'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/497/downloads/paper-1.20.4-497.jar',
                path.join(this.serverPath, this.jarFile),
                'Paper Server'
            );

            await this.sleep(1000);

            console.log('📥 Step 2/5: Downloading Geyser (Bedrock support)...');
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'Geyser-Spigot.jar'),
                'Geyser Plugin'
            );

            await this.sleep(1000);

            console.log('📥 Step 3/5: Downloading Floodgate (Bedrock auth)...');
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'floodgate-spigot.jar'),
                'Floodgate Plugin'
            );

            await this.sleep(1000);

            console.log('📥 Step 4/5: Downloading ViaVersion (multi-version)...');
            await this.downloadFile(
                'https://hangar.papermc.io/api/v1/projects/ViaVersion/versions/5.4.1/PAPER/download',
                path.join(this.serverPath, 'plugins', 'ViaVersion.jar'),
                'ViaVersion Plugin'
            );

            await this.sleep(1000);

            console.log('📥 Step 5/5: Downloading ViaBackwards (backward compatibility)...');
            await this.downloadFile(
                'https://hangar.papermc.io/api/v1/projects/ViaBackwards/versions/5.3.2/PAPER/download',
                path.join(this.serverPath, 'plugins', 'ViaBackwards.jar'),
                'ViaBackwards Plugin'
            );

            console.log('✅ All crossplay server files downloaded successfully');
        } catch (error) {
            console.error('❌ Error downloading files:', error.message);
            throw error;
        }
    }

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
                    timeout: 30000
                }, (response) => {
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
        this.app.use(express.json({ limit: '1mb' }));
        this.app.use(express.static('public', {
            maxAge: '1d',
            etag: false
        }));

        try {
            const cors = require('cors');
            this.app.use(cors({
                origin: false,
                credentials: false
            }));
        } catch (error) {
            console.log('⚠️  CORS module not found, skipping...');
        }

        this.app.get('/health', (req, res) => {
            res.json({
                status: 'healthy',
                server: this.serverStatus,
                initialized: this.initializationComplete,
                memory: this.getMemoryUsage(),
                timestamp: Date.now()
            });
        });
    }

    getMemoryUsage() {
        try {
            const used = process.memoryUsage();
            return {
                rss: Math.round(used.rss / 1024 / 1024) + 'MB',
                heapUsed: Math.round(used.heapUsed / 1024 / 1024) + 'MB',
                heapTotal: Math.round(used.heapTotal / 1024 / 1024) + 'MB'
            };
        } catch (error) {
            return { error: 'Unable to get memory usage' };
        }
    }

    setupRoutes() {
        // Main route - will serve your custom index.html
        this.app.get('/', (req, res) => {
            try {
                const indexPath = path.join(__dirname, 'public', 'index.html');
                if (fs.existsSync(indexPath)) {
                    res.sendFile(indexPath);
                } else {
                    res.send('<h1>Minecraft Crossplay Server</h1><p>index.html not found in public folder</p>');
                }
            } catch (error) {
                res.send('<h1>Minecraft Crossplay Server</h1><p>Error loading interface</p>');
            }
        });

        // Status endpoint - Compatible with your HTML
        this.app.get('/status', (req, res) => {
            const uptime = this.startTime ? Math.floor((Date.now() - this.startTime) / 1000) : 0;
            res.json({
                status: this.serverStatus,
                running: this.minecraftProcess !== null,
                ready: this.serverReady,
                initialized: this.initializationComplete,
                uptime: uptime,
                localIP: this.localIP,
                publicIP: this.publicIP,
                javaPort: this.javaPort,
                bedrockPort: this.bedrockPort,
                memory: this.getMemoryUsage(),
                connections: {
                    local: {
                        java: `${this.localIP}:${this.javaPort}`,
                        bedrock: `${this.localIP}:${this.bedrockPort}`
                    },
                    network: {
                        java: `${this.localIP}:${this.javaPort}`,
                        bedrock: `${this.localIP}:${this.bedrockPort}`
                    },
                    internet: this.publicIP && this.publicIP !== 'Unable to detect' ? {
                        java: `${this.publicIP}:${this.javaPort}`,
                        bedrock: `${this.publicIP}:${this.bedrockPort}`,
                        note: this.isProduction ? "Direct connection available" : "Port forwarding required"
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
            if (this.serverStatus !== 'online' || !command) {
                return res.json({
                    success: false,
                    message: 'Server must be online and command must be provided'
                });
            }

            this.executeCommand(command);
            res.json({
                success: true,
                message: `Command sent: ${command}`
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
max-players=10
motd=§aCrossplay Server §7| §eOptimized §7| §bAll Versions
server-name=CrossplayServer
online-mode=false
enforce-whitelist=false

# Optimized Settings
view-distance=6
simulation-distance=4
max-tick-time=60000

# Entity optimizations
entity-activation-range.animals=16
entity-activation-range.monsters=24
entity-activation-range.raiders=32
entity-activation-range.misc=8
tick-inactive-villagers=false

# Performance tweaks
max-auto-save-chunks-per-tick=6
auto-save-interval=6000
max-world-size=10000
network-compression-threshold=256
enable-query=true
enable-status=true
enable-command-block=true
spawn-protection=0
allow-nether=true
allow-end=true
level-name=world
require-resource-pack=false
prevent-proxy-connections=false
use-native-transport=true
        `.trim();

        if (!fs.existsSync(this.serverPath)) {
            fs.mkdirSync(this.serverPath, { recursive: true });
        }

        fs.writeFileSync(propertiesPath, properties);

        const eulaPath = path.join(this.serverPath, 'eula.txt');
        fs.writeFileSync(eulaPath, 'eula=true');
    }

    startMemoryMonitoring() {
        this.memoryMonitorInterval = setInterval(() => {
            if (this.minecraftProcess) {
                try {
                    exec(`ps -p ${this.minecraftProcess.pid} -o pid,rss,vsz --no-headers`, (error, stdout) => {
                        if (!error && stdout.trim()) {
                            const [pid, rss, vsz] = stdout.trim().split(/\s+/);
                            const memoryMB = Math.round(rss / 1024);
                            console.log(`📊 Minecraft Memory Usage: ${memoryMB}MB RSS`);

                            if (memoryMB > 700) {
                                console.log('⚠️  High memory usage detected.');
                            }
                        }
                    });
                } catch (error) {
                    // Silently handle errors
                }
            }
        }, 60000);
    }

    stopMemoryMonitoring() {
        if (this.memoryMonitorInterval) {
            clearInterval(this.memoryMonitorInterval);
            this.memoryMonitorInterval = null;
        }
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
        console.log('🚀 STARTING MINECRAFT CROSSPLAY SERVER');
        console.log('='.repeat(60));
        console.log('📡 Status: STARTING...');
        console.log(`🌐 Public IP: ${this.publicIP || 'Detecting...'}`);
        console.log('💾 Memory: Optimized for stability');
        console.log('⏳ Please wait while server initializes...');
        console.log('='.repeat(60));

        // Memory-optimized JVM arguments
        const javaArgs = [
            '-Xmx768M',                    // Maximum memory for stability
            '-Xms256M',                    // Initial memory
            '-XX:+UseG1GC',                // G1 garbage collector
            '-XX:MaxGCPauseMillis=200',    // GC pause optimization
            '-XX:G1HeapRegionSize=16M',    // G1 region size
            '-XX:+DisableExplicitGC',
            '-XX:+UseCompressedOops',
            '-XX:+OptimizeStringConcat',
            '-Dfile.encoding=UTF-8',
            '-Djava.awt.headless=true',
            '-Dpaper.playerconnection.keepalive=60',
            '-jar',
            this.jarFile,
            'nogui'
        ];

        console.log('💾 JVM Settings: Max 768MB, G1GC, Optimized');

        this.minecraftProcess = spawn('java', javaArgs, {
            cwd: this.serverPath,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
                ...process.env,
                JAVA_HOME: '/usr/lib/jvm/java-21-openjdk'
            }
        });

        this.minecraftProcess.stdout.on('data', (data) => {
            const message = data.toString().trim();
            console.log(`[MC]: ${message}`);

            if (message.includes('Done (') && message.includes('For help, type "help"')) {
                this.serverStatus = 'online';
                this.serverReady = true;
                this.restartAttempts = 0;
                console.log('\n' + '🎉'.repeat(20));
                console.log('✅ CROSSPLAY SERVER IS NOW ONLINE!');
                console.log('🎉'.repeat(20));

                this.startMemoryMonitoring();
                setTimeout(() => this.displayConnectionInfo(), 1000);
            }

            if (message.includes('Geyser') && message.includes('Started Geyser')) {
                console.log('🔗 Crossplay bridge (Geyser) is ONLINE!');
            }

            if (message.includes('ViaVersion') && message.includes('enabled')) {
                console.log('🔄 Multi-version support (ViaVersion) is ONLINE!');
            }
        });

        this.minecraftProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            if (error.includes('ERROR') || error.includes('FATAL') || error.includes('OutOfMemoryError')) {
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

            this.stopMemoryMonitoring();

            if (code !== 0) {
                console.log('💥 Server crashed! Check the error messages above.');

                if (this.restartAttempts < 2) {
                    this.restartAttempts++;
                    console.log(`🔄 Auto-restarting in 30 seconds... (attempt ${this.restartAttempts}/2)`);
                    setTimeout(() => {
                        this.startMinecraftServer();
                    }, 30000);
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
        console.log('\n' + '='.repeat(70));
        console.log('🎮 MINECRAFT CROSSPLAY SERVER IS ONLINE! 🎮');
        console.log('='.repeat(70));

        if (this.publicIP && this.publicIP !== 'Unable to detect') {
            console.log('\n📋 SHARE WITH FRIENDS:');
            console.log(`   Java Edition: ${this.publicIP}:${this.javaPort}`);
            console.log(`   Bedrock Edition: ${this.publicIP}:${this.bedrockPort}`);
            console.log('   ✅ No port forwarding needed!');
        }

        console.log(`\n🌐 Web Management: https://${this.publicIP}`);

        console.log('\n🎯 SUPPORTED VERSIONS:');
        console.log('   📱 Java Edition: 1.8.x to 1.21.x (ALL VERSIONS)');
        console.log('   🎮 Bedrock Edition: All platforms');
        console.log('\n💾 FEATURES: Crossplay, Multi-version, Memory optimized');
        console.log('='.repeat(70) + '\n');
    }

    stopMinecraftServer() {
        if (this.minecraftProcess) {
            this.serverStatus = 'stopping';
            console.log('\n⏹️  Stopping Minecraft server...');

            this.stopMemoryMonitoring();

            try {
                this.minecraftProcess.stdin.write('stop\n');
            } catch (error) {
                console.log('⚠️  Error sending stop command, forcing shutdown...');
                this.minecraftProcess.kill('SIGTERM');
            }

            setTimeout(() => {
                if (this.minecraftProcess) {
                    console.log('⚠️  Force stopping server...');
                    this.minecraftProcess.kill('SIGKILL');
                }
            }, 15000);
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

        process.on('SIGTERM', () => {
            console.log('📡 Received SIGTERM. Gracefully shutting down...');
            this.stopMinecraftServer();
            setTimeout(() => process.exit(0), 5000);
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
            console.log(`🎨 Using custom web interface from public/index.html`);
            console.log(`💾 Memory-optimized deployment (Fixed OutOfMemoryError)`);
            console.log(`🌐 Public URL will be available after deployment`);
            console.log('='.repeat(50));
        });
    }
}

const manager = new MinecraftCrossplayServer();
manager.start();
