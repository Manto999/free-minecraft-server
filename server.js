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
        this.downloadQueue = [];
        this.memoryMonitorInterval = null;

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
            }, 2000);
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
            if (process.env.KOYEB_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL) {
                this.publicIP = process.env.KOYEB_PUBLIC_DOMAIN || process.env.RAILWAY_STATIC_URL;
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

    // Minimal download setup to prevent memory issues
    async downloadRequiredFiles() {
        console.log('📥 Downloading minimal server files for memory optimization...');

        if (!fs.existsSync(this.serverPath)) {
            fs.mkdirSync(this.serverPath, { recursive: true });
        }

        if (!fs.existsSync(path.join(this.serverPath, 'plugins'))) {
            fs.mkdirSync(path.join(this.serverPath, 'plugins'), { recursive: true });
        }

        try {
            // Essential files only to reduce memory usage
            console.log('📥 Step 1/3: Downloading Paper server...');
            await this.downloadFile(
                'https://api.papermc.io/v2/projects/paper/versions/1.20.4/builds/497/downloads/paper-1.20.4-497.jar',
                path.join(this.serverPath, this.jarFile),
                'Paper Server'
            );

            await this.sleep(1500);

            console.log('📥 Step 2/3: Downloading Geyser (essential for crossplay)...');
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/geyser/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'Geyser-Spigot.jar'),
                'Geyser Plugin'
            );

            await this.sleep(1500);

            console.log('📥 Step 3/3: Downloading Floodgate (essential for crossplay)...');
            await this.downloadFile(
                'https://download.geysermc.org/v2/projects/floodgate/versions/latest/builds/latest/downloads/spigot',
                path.join(this.serverPath, 'plugins', 'floodgate-spigot.jar'),
                'Floodgate Plugin'
            );

            // Skip ViaVersion/ViaBackwards to save memory and prevent compatibility issues
            console.log('⚠️  Running in minimal mode - ViaVersion plugins skipped to save memory');
            console.log('✅ Essential crossplay files downloaded successfully');
        } catch (error) {
            console.error('❌ Error downloading files:', error.message);
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
        this.app.get('/', (req, res) => {
            try {
                const indexPath = path.join(__dirname, 'public', 'index.html');
                if (fs.existsSync(indexPath)) {
                    res.sendFile(indexPath);
                } else {
                    res.send(`
                        <h1>🎮 Minecraft Crossplay Server</h1>
                        <p><strong>Status:</strong> ${this.serverStatus}</p>
                        <p><strong>Java Edition:</strong> ${this.publicIP}:${this.javaPort}</p>
                        <p><strong>Bedrock Edition:</strong> ${this.publicIP}:${this.bedrockPort}</p>
                        <p>✅ Server is running with memory optimization!</p>
                    `);
                }
            } catch (error) {
                res.send('<h1>Minecraft Crossplay Server</h1><p>Server is running!</p>');
            }
        });

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
                memory: this.getMemoryUsage(),
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
                message: 'Server is starting with memory optimization...',
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

        // Memory-optimized server properties
        const properties = `
server-ip=0.0.0.0
server-port=${this.javaPort}
gamemode=survival
difficulty=easy
max-players=6
motd=§aCrossplay Server §7| §eMemory Optimized §7| §bStable
server-name=OptimizedCrossplayServer
online-mode=false
enforce-whitelist=false

# Memory-Optimized Settings
view-distance=3
simulation-distance=2
max-tick-time=60000

# Chunk loading optimizations
max-auto-save-chunks-per-tick=3
chunk-gc-period=600
max-world-size=3000

# Entity optimizations (reduce memory usage)
entity-activation-range.animals=12
entity-activation-range.monsters=16
entity-activation-range.raiders=24
entity-activation-range.misc=4
tick-inactive-villagers=false
entity-broadcast-range-percentage=50

# Network optimizations
network-compression-threshold=256
enable-query=false
enable-status=true
enable-command-block=false
spawn-protection=0

# World settings
allow-nether=true
allow-end=false
level-name=world
require-resource-pack=false
prevent-proxy-connections=false

# Performance tweaks
use-native-transport=true
sync-chunk-writes=false
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
                            console.log(`📊 Memory Usage: ${memoryMB}MB RSS`);

                            if (memoryMB > 600) {
                                console.log('⚠️  High memory usage detected. Server may need optimization.');
                            }
                        }
                    });
                } catch (error) {
                    // Silently handle errors to prevent spam
                }
            }
        }, 60000); // Check every minute
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
        console.log('🚀 STARTING MEMORY-OPTIMIZED CROSSPLAY SERVER');
        console.log('='.repeat(60));
        console.log('📡 Status: STARTING...');
        console.log(`🌐 Public IP: ${this.publicIP || 'Detecting...'}`);
        console.log('💾 Memory: Fixed OutOfMemoryError issues');
        console.log('⏳ Please wait while server initializes...');
        console.log('='.repeat(60));

        // Memory-optimized JVM arguments (Fixed OutOfMemoryError)
        const javaArgs = [
            '-Xmx768M',                    // Increased to 768MB (Railway can handle this)
            '-Xms256M',                    // Increased initial memory
            '-XX:+UseG1GC',                // Switch back to G1GC for better memory management
            '-XX:MaxGCPauseMillis=200',    // Shorter pauses but more frequent
            '-XX:G1HeapRegionSize=16M',    // Optimize G1 regions for our heap size
            '-XX:+DisableExplicitGC',
            '-XX:+UseCompressedOops',
            '-XX:+OptimizeStringConcat',
            '-Dfile.encoding=UTF-8',
            '-Djava.awt.headless=true',
            // Minecraft-specific memory optimizations
            '-Dpaper.playerconnection.keepalive=60',
            '-Dpaper.maxChunkSendsPerTick=56',  // Limit chunk sending
            '-jar',
            this.jarFile,
            'nogui'
        ];

        console.log('💾 JVM Settings: Max 768MB, G1GC, Memory-optimized');

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
                console.log('✅ MEMORY-OPTIMIZED SERVER IS NOW ONLINE!');
                console.log('🎉'.repeat(20));

                // Start memory monitoring
                this.startMemoryMonitoring();

                setTimeout(() => this.displayConnectionInfo(), 1000);
            }

            if (message.includes('Geyser') && message.includes('Started')) {
                console.log('🔗 Crossplay bridge (Geyser) is ONLINE!');
            }
        });

        this.minecraftProcess.stderr.on('data', (data) => {
            const error = data.toString().trim();
            // Log important errors and memory issues
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

            // Stop memory monitoring
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
        console.log('   📱 Java Edition: 1.20.4 (stable)');
        console.log('   🎮 Bedrock Edition: All platforms');
        console.log('\n💾 MEMORY STATUS: Optimized to prevent OutOfMemoryError');
        console.log('='.repeat(60) + '\n');
    }

    stopMinecraftServer() {
        if (this.minecraftProcess) {
            this.serverStatus = 'stopping';
            console.log('\n⏹️  Stopping Minecraft server...');

            // Stop memory monitoring
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
            console.log(`💾 Memory-optimized deployment (Fixed OutOfMemoryError)`);
            console.log(`🌐 Public URL will be available after deployment`);
            console.log('='.repeat(50));
        });
    }
}

const manager = new MinecraftCrossplayServer();
manager.start();
