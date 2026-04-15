const WebSocket = require('ws');

const CANVAS_SIZE = 1024;
const PORT = process.env.PORT || 8080;
// Хранилище данных в памяти (Render бесплатный не сохраняет файлы надёжно)
let canvasData = new Uint32Array(CANVAS_SIZE * CANVAS_SIZE);
canvasData.fill(0xFFFFFFFF); // Белый фон

const wss = new WebSocket.Server({ port: PORT });
console.log(`WebSocket server running on port ${PORT}`);

let onlineCount = 0;

function broadcast(message, excludeWs = null) {
    wss.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(message));
        }
    });
}

function broadcastOnlineCount() {
    broadcast({ type: 'onlineCount', count: onlineCount });
}

// Восстановление из переменной окружения (если есть)
if (process.env.CANVAS_DATA) {
    try {
        canvasData = new Uint32Array(JSON.parse(process.env.CANVAS_DATA));
        console.log('Canvas restored from environment');
    } catch (e) {
        console.error('Failed to restore canvas:', e);
    }
}

wss.on('connection', (ws) => {
    onlineCount++;
    console.log(`Client connected. Online: ${onlineCount}`);
    broadcastOnlineCount();
    
    // Отправляем начальное состояние
    ws.send(JSON.stringify({
        type: 'init',
        canvas: Array.from(canvasData),
        onlineCount: onlineCount
    }));
    
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'placePixel') {
                const { x, y, color } = message;
                
                if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) return;
                
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                const colorValue = 0xFF000000 | (b << 16) | (g << 8) | r;
                
                const index = y * CANVAS_SIZE + x;
                
                if (canvasData[index] === colorValue) return;
                
                canvasData[index] = colorValue;
                
                broadcast({
                    type: 'pixelUpdate',
                    x: x,
                    y: y,
                    color: color
                }, ws);
            }
        } catch (e) {
            console.error('Failed to parse message:', e);
        }
    });
    
    ws.on('close', () => {
        onlineCount--;
        console.log(`Client disconnected. Online: ${onlineCount}`);
        broadcastOnlineCount();
    });
});
