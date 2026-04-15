const WebSocket = require('ws');
const { createClient } = require('@supabase/supabase-js');

const CANVAS_SIZE = 1024;
const PORT = process.env.PORT || 8080;

// Ваши данные Supabase
const SUPABASE_URL = 'https://ojdnhvtlzhuxjymlmycj.supabase.co';
const SUPABASE_KEY = 'sb_publishable_Zrqe14byhLV4doJJ57lMsQ_7yh_ON38';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Инициализация полотна (белый фон)
let canvasData = new Uint32Array(CANVAS_SIZE * CANVAS_SIZE);
canvasData.fill(0xFFFFFFFF);

// Загрузка всех пикселей из Supabase при старте
async function loadCanvasFromSupabase() {
    try {
        let allPixels = [];
        let page = 0;
        const pageSize = 1000;
        let hasMore = true;
        
        // Загружаем все пиксели постранично
        while (hasMore) {
            const { data: pixels, error } = await supabase
                .from('pixels')
                .select('*')
                .range(page * pageSize, (page + 1) * pageSize - 1);
            
            if (error) {
                console.error('Error loading canvas:', error);
                return;
            }
            
            if (pixels && pixels.length > 0) {
                allPixels = allPixels.concat(pixels);
                page++;
            } else {
                hasMore = false;
            }
        }
        
        // Применяем загруженные пиксели
        for (const pixel of allPixels) {
            const { x, y, color } = pixel;
            const r = parseInt(color.slice(1, 3), 16);
            const g = parseInt(color.slice(3, 5), 16);
            const b = parseInt(color.slice(5, 7), 16);
            const colorValue = 0xFF000000 | (b << 16) | (g << 8) | r;
            
            const index = y * CANVAS_SIZE + x;
            canvasData[index] = colorValue;
        }
        
        console.log(`Loaded ${allPixels.length} pixels from Supabase`);
    } catch (e) {
        console.error('Failed to load canvas:', e);
    }
}

// Сохранение пикселя в Supabase
async function savePixelToSupabase(x, y, color) {
    try {
        const { data, error } = await supabase
            .from('pixels')
            .upsert({ x, y, color, updated_at: new Date() }, { onConflict: 'x, y' });
        
        if (error) {
            console.error('Error saving pixel:', error);
            return false;
        }
        
        return true;
    } catch (e) {
        console.error('Failed to save pixel:', e);
        return false;
    }
}

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
    
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            if (message.type === 'placePixel') {
                const { x, y, color } = message;
                
                if (x < 0 || x >= CANVAS_SIZE || y < 0 || y >= CANVAS_SIZE) {
                    return;
                }
                
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                const colorValue = 0xFF000000 | (b << 16) | (g << 8) | r;
                
                const index = y * CANVAS_SIZE + x;
                
                if (canvasData[index] === colorValue) {
                    return;
                }
                
                // Сохраняем в Supabase
                const saved = await savePixelToSupabase(x, y, color);
                
                if (saved) {
                    canvasData[index] = colorValue;
                    
                    broadcast({
                        type: 'pixelUpdate',
                        x: x,
                        y: y,
                        color: color
                    }, ws);
                    
                    console.log(`Pixel placed at (${x}, ${y}) with color ${color}`);
                }
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
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
    });
});

// Подписка на изменения в Supabase (Realtime)
async function subscribeToChanges() {
    const subscription = supabase
        .channel('pixels-changes')
        .on('postgres_changes', 
            { event: '*', schema: 'public', table: 'pixels' },
            (payload) => {
                if (payload.eventType === 'INSERT' || payload.eventType === 'UPDATE') {
                    const { x, y, color } = payload.new;
                    const r = parseInt(color.slice(1, 3), 16);
                    const g = parseInt(color.slice(3, 5), 16);
                    const b = parseInt(color.slice(5, 7), 16);
                    const colorValue = 0xFF000000 | (b << 16) | (g << 8) | r;
                    
                    const index = y * CANVAS_SIZE + x;
                    canvasData[index] = colorValue;
                    
                    broadcast({
                        type: 'pixelUpdate',
                        x: x,
                        y: y,
                        color: color
                    });
                }
            })
        .subscribe();
    
    console.log('Subscribed to Supabase realtime changes');
}

// Запуск
async function start() {
    await loadCanvasFromSupabase();
    await subscribeToChanges();
}

start();
