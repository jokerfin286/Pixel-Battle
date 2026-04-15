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

// Кэш для быстрой отправки новым клиентам
let cachedCanvasArray = null;
let lastUpdateTime = Date.now();
let pixelsCount = 0;

// Сжатие данных через RLE (Run-Length Encoding)
function compressCanvas(data) {
    const compressed = [];
    let count = 1;
    let current = data[0];
    
    for (let i = 1; i < data.length; i++) {
        if (data[i] === current && count < 65535) {
            count++;
        } else {
            compressed.push([current, count]);
            current = data[i];
            count = 1;
        }
    }
    compressed.push([current, count]);
    
    // Преобразуем в плоский массив для JSON
    return compressed.flat();
}

// Распаковка RLE
function decompressCanvas(compressed) {
    const data = new Uint32Array(CANVAS_SIZE * CANVAS_SIZE);
    let index = 0;
    
    for (let i = 0; i < compressed.length; i += 2) {
        const color = compressed[i];
        const count = compressed[i + 1];
        
        for (let j = 0; j < count; j++) {
            data[index++] = color;
        }
    }
    
    return data;
}

// Обновление кэша
function updateCache() {
    cachedCanvasArray = compressCanvas(canvasData);
    lastUpdateTime = Date.now();
}

// Загрузка всех пикселей из Supabase при старте
async function loadCanvasFromSupabase() {
    console.time('Load from Supabase');
    
    try {
        // Загружаем все пиксели одним запросом с увеличенным лимитом
        const { data: pixels, error, count } = await supabase
            .from('pixels')
            .select('*', { count: 'exact' })
            .limit(100000); // Максимальный лимит Supabase
        
        if (error) {
            console.error('Error loading canvas:', error);
            return;
        }
        
        if (pixels && pixels.length > 0) {
            // Применяем загруженные пиксели
            for (const pixel of pixels) {
                const { x, y, color } = pixel;
                const r = parseInt(color.slice(1, 3), 16);
                const g = parseInt(color.slice(3, 5), 16);
                const b = parseInt(color.slice(5, 7), 16);
                const colorValue = 0xFF000000 | (b << 16) | (g << 8) | r;
                
                const index = y * CANVAS_SIZE + x;
                canvasData[index] = colorValue;
            }
            
            pixelsCount = pixels.length;
        }
        
        console.timeEnd('Load from Supabase');
        console.log(`Loaded ${pixelsCount} pixels from Supabase`);
        
        // Обновляем кэш после загрузки
        updateCache();
        
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
        
        pixelsCount++;
        return true;
    } catch (e) {
        console.error('Failed to save pixel:', e);
        return false;
    }
}

const wss = new WebSocket.Server({ 
    port: PORT,
    // Увеличиваем лимиты для больших сообщений
    maxPayload: 50 * 1024 * 1024 // 50 MB
});

console.log(`WebSocket server running on port ${PORT}`);

let onlineCount = 0;

function broadcast(message, excludeWs = null) {
    const messageStr = JSON.stringify(message);
    wss.clients.forEach(client => {
        if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
            client.send(messageStr);
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
    
    // Отправляем начальное состояние (используем кэш)
    if (cachedCanvasArray) {
        // Отправляем сжатые данные
        ws.send(JSON.stringify({
            type: 'init',
            canvas: cachedCanvasArray,
            compressed: true,
            onlineCount: onlineCount
        }));
        console.log(`Sent cached canvas (${cachedCanvasArray.length} bytes)`);
    } else {
        // Если кэша нет, отправляем обычный массив
        ws.send(JSON.stringify({
            type: 'init',
            canvas: Array.from(canvasData),
            compressed: false,
            onlineCount: onlineCount
        }));
    }
    
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
                
                // Сохраняем в Supabase (асинхронно, не блокируем)
                savePixelToSupabase(x, y, color).then(saved => {
                    if (saved) {
                        canvasData[index] = colorValue;
                        
                        // Обновляем кэш только раз в секунду
                        const now = Date.now();
                        if (now - lastUpdateTime > 1000) {
                            updateCache();
                        }
                        
                        broadcast({
                            type: 'pixelUpdate',
                            x: x,
                            y: y,
                            color: color
                        }, ws);
                    }
                });
                
                // Сразу обновляем локально и отправляем другим
                canvasData[index] = colorValue;
                
                broadcast({
                    type: 'pixelUpdate',
                    x: x,
                    y: y,
                    color: color
                }, ws);
                
                console.log(`Pixel placed at (${x}, ${y}) with color ${color}`);
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

// Периодическое обновление кэша
setInterval(() => {
    updateCache();
}, 5000);

// Запуск
async function start() {
    await loadCanvasFromSupabase();
    await subscribeToChanges();
}

start();
