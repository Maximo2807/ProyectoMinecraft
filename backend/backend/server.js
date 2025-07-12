const express = require('express');
const cors = require('cors');
const Docker = require('dockerode');
const http = require('http');
const { Server } = require("socket.io");
const { Rcon } = require('rcon-client');

// --- CONFIGURACIÓN INICIAL ---
const app = express();
const server = http.createServer(app);
const PORT = 3000;

const docker = new Docker({ socketPath: '/var/run/docker.sock' });
const { 
    MINECRAFT_CONTAINER_NAME, 
    MINECRAFT_RCON_HOST, 
    MINECRAFT_RCON_PORT, 
    MINECRAFT_RCON_PASSWORD 
} = process.env;

if (!MINECRAFT_CONTAINER_NAME || !MINECRAFT_RCON_HOST || !MINECRAFT_RCON_PORT || !MINECRAFT_RCON_PASSWORD) {
    console.error("Error: Faltan variables de entorno. Asegúrate de que todas las variables de Minecraft están definidas en docker-compose.yml.");
    process.exit(1);
}

// Configuración de CORS para Express y Socket.IO
const corsOptions = { origin: "http://localhost:8080", methods: ["GET", "POST"] };
app.use(cors(corsOptions));
app.use(express.json());

const io = new Server(server, { cors: corsOptions });

// --- LÓGICA DE DOCKER (START/STOP/STATUS) ---
const getContainer = () => docker.getContainer(MINECRAFT_CONTAINER_NAME);

app.get('/api/server/status', async (req, res) => {
    try {
        const data = await getContainer().inspect();
        res.json({ status: data.State.Running ? 'on' : 'off' });
    } catch (error) {
        res.status(404).json({ status: 'off', error: 'Contenedor no encontrado' });
    }
});

app.post('/api/server/start', async (req, res) => {
    try {
        await getContainer().start();
        res.json({ success: true, message: 'Servidor encendiéndose...' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error al encender el servidor.' });
    }
});

app.post('/api/server/stop', async (req, res) => {
    try {
        await getContainer().stop();
        res.json({ success: true, message: 'Servidor apagándose...' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error al apagar el servidor.' });
    }
});

// --- LÓGICA DE RCON (LISTA DE JUGADORES) ---
app.get('/api/server/players', async (req, res) => {
    try {
        const rcon = await Rcon.connect({
            host: MINECRAFT_RCON_HOST,
            port: MINECRAFT_RCON_PORT,
            password: MINECRAFT_RCON_PASSWORD,
        });
        const response = await rcon.send("list");
        rcon.end();

        if (!response) {
            return res.json({ players: [] });
        }
        
        const parts = response.split(':');
        const playerNames = parts.length > 1 ? parts[1].trim().split(', ').filter(Boolean) : [];
        const players = playerNames.map(name => ({
            name: name,
            avatar: `https://cravatar.eu/helmavatar/${name}/80.png`
        }));
        
        res.json({ players });

    } catch (error) {
        console.error("Error de RCON:", error.message);
        res.status(500).json({ players: [], error: 'No se pudo conectar a RCON. ¿Está el servidor encendido y la contraseña es correcta?' });
    }
});

// --- LÓGICA DE WEBSOCKETS (CONSOLA EN VIVO) ---
io.on('connection', (socket) => {
    console.log('Un cliente se ha conectado a la consola.');

    const container = getContainer();
    container.logs({ follow: true, stdout: true, stderr: true }, (err, stream) => {
        if (err) {
            socket.emit('log', `Error al obtener logs: ${err.message}`);
            return;
        }

        stream.on('data', chunk => {
            socket.emit('log', chunk.toString('utf8'));
        });

        stream.on('end', () => {
            socket.emit('log', '--- Stream de logs finalizado ---');
        });

        socket.on('disconnect', () => {
            console.log('Cliente de consola desconectado.');
            stream.destroy();
        });
    });
});

// Iniciar el servidor
server.listen(PORT, () => {
    console.log(`Servidor backend funcional corriendo en http://localhost:${PORT}`);
    console.log(`Apuntando al contenedor de Minecraft: ${MINECRAFT_CONTAINER_NAME}`);
});
