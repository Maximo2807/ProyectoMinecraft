const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const http = require('http');
const { Server } = require("socket.io");
const { Rcon } = require('rcon-client');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const multer = require('multer');

// --- CONFIGURACIÓN INICIAL ---
const app = express();
const server = http.createServer(app);
const PORT = 3000;
const SERVER_DATA_PATH = '/minecraft-server-data';

// --- CONFIGURACIÓN DE LA BASE DE DATOS (SIN EMAIL) ---
const dbDir = path.join(__dirname, 'data');
if (!fsSync.existsSync(dbDir)) { fsSync.mkdirSync(dbDir); }
const dbPath = path.join(dbDir, 'panel_users.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error("Error al abrir la base de datos", err.message); } 
    else {
        console.log("Conectado a la base de datos SQLite.");
        db.run(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, firstName TEXT, lastName TEXT, dob TEXT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL)`);
    }
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const modsDir = path.join(SERVER_DATA_PATH, 'mods');
        fsSync.mkdirSync(modsDir, { recursive: true });
        cb(null, modsDir);
    },
    filename: (req, file, cb) => cb(null, file.originalname)
});
const upload = multer({ storage: storage });

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const { MINECRAFT_CONTAINER_NAME, MINECRAFT_RCON_HOST, MINECRAFT_RCON_PORT, MINECRAFT_RCON_PASSWORD } = process.env;

if (!MINECRAFT_CONTAINER_NAME || !MINECRAFT_RCON_HOST || !MINECRAFT_RCON_PORT || !MINECRAFT_RCON_PASSWORD) {
    console.error("Error: Faltan variables de entorno de Minecraft.");
    process.exit(1);
}

const corsOptions = { origin: "http://localhost:8080", methods: ["GET", "POST"] };
app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

const io = new Server(server, { cors: corsOptions });

// --- RUTA DE DIAGNÓSTICO ---
app.get('/', (req, res) => res.status(200).json({ status: 'Backend is running' }));

// --- RUTAS DE AUTENTICACIÓN (SIN EMAIL) ---
app.post('/api/auth/register', (req, res) => {
    const { username, password, firstName, lastName, dob } = req.body;
    if (!username || !password) { return res.status(400).json({ success: false, message: 'Usuario y contraseña son obligatorios.' }); }
    bcrypt.hash(password, 10, (err, hash) => {
        if (err) { return res.status(500).json({ success: false, message: 'Error al encriptar la contraseña.' }); }
        const sql = `INSERT INTO users (username, password, firstName, lastName, dob) VALUES (?, ?, ?, ?, ?)`;
        db.run(sql, [username, hash, firstName || '', lastName || '', dob || ''], function(err) {
            if (err) {
                if (err.message.includes("UNIQUE constraint failed")) { return res.status(409).json({ success: false, message: 'El nombre de usuario ya existe.' }); }
                return res.status(500).json({ success: false, message: 'Error al registrar el usuario.' });
            }
            res.status(201).json({ success: true, message: 'Usuario registrado con éxito.' });
        });
    });
});
app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) { return res.status(400).json({ success: false, message: 'Usuario y contraseña son obligatorios.' }); }
    const sql = `SELECT * FROM users WHERE username = ?`;
    db.get(sql, [username], (err, user) => {
        if (err) { return res.status(500).json({ success: false, message: 'Error del servidor.' }); }
        if (!user) { return res.status(401).json({ success: false, message: 'Credenciales inválidas.' }); }
        bcrypt.compare(password, user.password, (err, isMatch) => {
            if (err) { return res.status(500).json({ success: false, message: 'Error del servidor.' }); }
            if (isMatch) { res.json({ success: true, message: 'Login exitoso.' }); } 
            else { res.status(401).json({ success: false, message: 'Credenciales inválidas.' }); }
        });
    });
});

// --- LÓGICA DE DOCKER (CON RECREACIÓN) ---
const getContainer = () => docker.getContainer(MINECRAFT_CONTAINER_NAME);

app.post('/api/server/recreate', async (req, res) => {
    const { version, forgeVersion } = req.body;
    if (!version || !forgeVersion) {
        return res.status(400).json({ success: false, message: 'Se requieren la versión de Minecraft y Forge.' });
    }
    try {
        const oldContainer = getContainer();
        await oldContainer.stop().catch(err => console.log("El contenedor ya estaba detenido."));
        await oldContainer.remove().catch(err => console.log("El contenedor ya había sido eliminado."));
        
        console.log(`Recreando el servidor con MC: ${version} y Forge: ${forgeVersion}`);

        const newContainer = await docker.createContainer({
            Image: 'itzg/minecraft-server:stable-java21-jdk',
            name: MINECRAFT_CONTAINER_NAME,
            HostConfig: {
                PortBindings: {
                    '25565/tcp': [{ HostPort: '25565' }],
                    '25575/tcp': [{ HostPort: '25575' }]
                },
                Binds: [`minecraft-data:/data`]
            },
            Env: [
                `EULA=TRUE`,
                `TYPE=FORGE`,
                `VERSION=${version}`,
                `FORGE_VERSION=${forgeVersion}`,
                `RCON_PORT=25575`,
                `RCON_PASSWORD=${MINECRAFT_RCON_PASSWORD}`,
                `MEMORY=4G`
            ],
            NetworkingConfig: {
                EndpointsConfig: {
                    'proyectominecraft_minecraft-net': {}
                }
            }
        });
        await newContainer.start();
        
        res.json({ success: true, message: 'Servidor recreado con las nuevas versiones. Puede tardar varios minutos en iniciar.' });
    } catch (error) {
        console.error("Error al recrear el contenedor:", error);
        res.status(500).json({ success: false, message: 'Error al recrear el servidor.' });
    }
});

const securePath = (userPath) => { const safePath = path.join(SERVER_DATA_PATH, userPath); if (!safePath.startsWith(SERVER_DATA_PATH)) { throw new Error('Intento de acceso a ruta no autorizada.'); } return safePath; };
const executeRconCommand = async (command) => { let rcon; try { rcon = await Rcon.connect({ host: MINECRAFT_RCON_HOST, port: MINECRAFT_RCON_PORT, password: MINECRAFT_RCON_PASSWORD }); await rcon.send(command); } finally { if (rcon) rcon.end(); } };
app.get('/api/files/list', async (req, res) => { try { const dirPath = req.query.path || '/'; const absolutePath = securePath(dirPath); const items = await fs.readdir(absolutePath, { withFileTypes: true }); const files = items.map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : 'file' })); res.json(files); } catch (error) { res.status(500).json({ error: 'No se pudo leer el directorio.', details: error.message }); } });
app.get('/api/files/content', async (req, res) => { try { const filePath = req.query.path; if (!filePath) return res.status(400).send('Ruta de archivo no especificada.'); const absolutePath = securePath(filePath); const content = await fs.readFile(absolutePath, 'utf-8'); res.send(content); } catch (error) { res.status(500).json({ error: 'No se pudo leer el archivo.', details: error.message }); } });
app.post('/api/files/save', async (req, res) => { try { const { path: filePath, content } = req.body; if (!filePath) return res.status(400).send('Ruta de archivo no especificada.'); const absolutePath = securePath(filePath); await fs.writeFile(absolutePath, content, 'utf-8'); res.json({ success: true, message: 'Archivo guardado con éxito.' }); } catch (error) { res.status(500).json({ error: 'No se pudo guardar el archivo.', details: error.message }); } });
app.get('/api/mods/list', async (req, res) => { try { const modsDir = path.join(SERVER_DATA_PATH, 'mods'); await fs.mkdir(modsDir, { recursive: true }); const items = await fs.readdir(modsDir); const jarFiles = items.filter(file => file.endsWith('.jar')); res.json(jarFiles); } catch (error) { res.status(500).json({ error: 'No se pudo leer la carpeta de mods.', details: error.message }); } });
app.post('/api/mods/upload', upload.array('mods'), (req, res) => { res.json({ success: true, message: `${req.files.length} mod(s) subidos correctamente.` }); });
app.post('/api/files/delete', async (req, res) => { try { const { path: filePath, type } = req.body; if (!filePath) return res.status(400).send('Ruta no especificada.'); const absolutePath = securePath(filePath); if (type === 'directory') { await fs.rm(absolutePath, { recursive: true, force: true }); } else { await fs.unlink(absolutePath); } res.json({ success: true, message: 'Elemento borrado con éxito.' }); } catch (error) { res.status(500).json({ error: 'No se pudo borrar el elemento.', details: error.message }); } });
app.get('/api/server/status', async (req, res) => { try { const data = await getContainer().inspect(); res.json({ status: data.State.Running ? 'on' : 'off' }); } catch (error) { res.status(404).json({ status: 'off', error: 'Contenedor no encontrado' }); } });
app.post('/api/server/start', async (req, res) => { try { await getContainer().start(); res.json({ success: true, message: 'Servidor encendiéndose...' }); } catch (error) { res.status(500).json({ success: false, message: 'Error al encender el servidor.' }); } });
app.post('/api/server/stop', async (req, res) => { try { await getContainer().stop(); res.json({ success: true, message: 'Servidor apagándose...' }); } catch (error) { res.status(500).json({ success: false, message: 'Error al apagar el servidor.' }); } });
app.get('/api/server/players', async (req, res) => { let rcon; try { rcon = await Rcon.connect({ host: MINECRAFT_RCON_HOST, port: MINECRAFT_RCON_PORT, password: MINECRAFT_RCON_PASSWORD }); const opListResponse = await rcon.send("op list"); const opNames = opListResponse.replace('The following players are operators: ', '').split(', ').filter(Boolean); const playerListResponse = await rcon.send("list"); const playerListParts = playerListResponse.split(':'); const playerNamesOnline = playerListParts.length > 1 ? playerListParts[1].trim().split(', ').filter(Boolean) : []; const players = playerNamesOnline.map(name => ({ name: name, avatar: `https://cravatar.eu/helmavatar/${name}/80.png`, isOp: opNames.includes(name) })); res.json({ players }); } catch (error) { console.error("Error de RCON:", error.message); res.status(500).json({ players: [], error: 'No se pudo conectar a RCON. ¿Está el servidor encendido y la contraseña es correcta?' }); } finally { if (rcon) rcon.end(); } });
app.post('/api/server/kick', async (req, res) => { const { player } = req.body; if (!player) return res.status(400).json({ success: false, error: 'Nombre de jugador no especificado.' }); try { await executeRconCommand(`kick ${player}`); res.json({ success: true, message: `Jugador ${player} kickeado.` }); } catch (error) { res.status(500).json({ success: false, error: 'Error al kickear al jugador.' }); } });
app.post('/api/server/ban', async (req, res) => { const { player } = req.body; if (!player) return res.status(400).json({ success: false, error: 'Nombre de jugador no especificado.' }); try { await executeRconCommand(`ban ${player}`); res.json({ success: true, message: `Jugador ${player} baneado.` }); } catch (error) { res.status(500).json({ success: false, error: 'Error al banear al jugador.' }); } });
app.post('/api/server/command', async (req, res) => { const { command } = req.body; if (!command) { return res.status(400).json({ success: false, error: 'Comando vacío.' }); } try { await executeRconCommand(command); res.json({ success: true, message: 'Comando enviado.' }); } catch (error) { res.status(500).json({ success: false, error: 'No se pudo enviar el comando a RCON.' }); } });
io.on('connection', (socket) => { const container = getContainer(); container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => { if (err) { return socket.emit('log', `Error: ${err.message}`); } stream.on('data', chunk => socket.emit('log', chunk.toString('utf8'))); stream.on('end', () => socket.emit('log', '--- Logs finalizados ---')); socket.on('disconnect', () => stream.destroy()); }); });

server.listen(PORT, () => console.log(`Servidor backend corriendo en http://localhost:${PORT}`));