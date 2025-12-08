// --- CONFIGURATION ---
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

if (typeof firebase !== 'undefined' && !firebase.apps.length) firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const syncRef = db.ref('sync');
const queueRef = db.ref('queue');
const chatRef = db.ref('chat');

let player, currentQueue = [], currentVideoId = null;
let lastBroadcaster = "System"; // Tracks who performed the last action
let isPartnerPlaying = false;
let isManualPause = false;

let myName = localStorage.getItem('deepSpaceUserName');
if (!myName) {
    myName = prompt("Enter your name (Sarthak or Reechita):") || "Guest";
    localStorage.setItem('deepSpaceUserName', myName);
}
// Normalize Name Capitalization
myName = myName.charAt(0).toUpperCase() + myName.slice(1).toLowerCase();

const partnerName = (myName.toLowerCase().includes("sarthak")) ? "Reechita" : "Sarthak";

// --- YOUTUBE PLAYER ---
function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%', videoId: '',
        playerVars: { 
            'controls': 1, 'disablekb': 0, 'rel': 0, 'modestbranding': 1, 'autoplay': 1, 'origin': window.location.origin 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) player.setVolume(85);
    setInterval(heartbeatSync, 1000);
    
    // Initial sync check
    syncRef.once('value').then(snapshot => {
        const state = snapshot.val();
        if(state) applyRemoteCommand(state, true);
    });
}

function heartbeatSync() {
    if (player && player.getPlayerState && currentVideoId && lastBroadcaster === myName) {
        const state = player.getPlayerState();
        if (state === YT.PlayerState.PLAYING) {
            if (player.getDuration() - player.getCurrentTime() < 1 && player.getDuration() > 0) {
                playNextSong();
            } else {
                broadcastState('play', player.getCurrentTime(), currentVideoId);
            }
        }
    }
}

function onPlayerStateChange(event) {
    const btn = document.getElementById('play-pause-btn');
    const state = event.data;

    if (state === YT.PlayerState.PLAYING) {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        isManualPause = false;
        
        if(!isPartnerPlaying) {
            lastBroadcaster = myName;
            broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    } else {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
        if (state === YT.PlayerState.PAUSED) {
            if (!isPartnerPlaying && lastBroadcaster === myName) {
                if (isManualPause) {
                    broadcastState('pause', player.getCurrentTime(), currentVideoId);
                } else {
                    broadcastState('ad_pause', player.getCurrentTime(), currentVideoId);
                }
            }
            isManualPause = false;
        }
        
        if (state === YT.PlayerState.ENDED) {
             playNextSong();
        }
    }
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player) return;
    const btn = document.getElementById('play-pause-btn');
    const state = player.getPlayerState();
    
    // When we toggle, WE become the broadcaster immediately
    lastBroadcaster = myName; 
    
    if (state === YT.PlayerState.PLAYING) {
        btn.innerHTML = '<i class="fa-solid fa-play"></i>';
        isManualPause = true;
        player.pauseVideo();
        broadcastState('pause', player.getCurrentTime(), currentVideoId);
    } else {
        btn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        if (!currentVideoId && currentQueue.length > 0) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title, currentQueue[0].uploader);
        } else if (currentVideoId) {
            player.playVideo();
            broadcastState('play', player.getCurrentTime(), currentVideoId);
        }
    }
}

// --- HELPER FUNCTIONS ---
function loadAndPlayVideo(videoId, title, uploader, startTime = 0) {
    if (player && videoId) {
        if(currentVideoId === videoId && player.cueVideoById) {
             if(Math.abs(player.getCurrentTime() - startTime) > 2) player.seekTo(startTime, true);
             player.playVideo();
             return;
        }

        player.loadVideoById({videoId: videoId, startSeconds: startTime});
        currentVideoId = videoId;
        
        document.getElementById('current-song-title').textContent = title;
        document.getElementById('current-song-artist').textContent = uploader || "Unknown Artist";
        
        renderQueue(currentQueue, currentVideoId);
    }
}

// --- QUEUE & DATA ---
function loadInitialData() {
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const data = snapshot.val();
        let list = [];
        if (data) Object.keys(data).forEach(k => list.push({ ...data[k], key: k }));
        list.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = list;
        renderQueue(currentQueue, currentVideoId);
    });

    syncRef.on('value', (snapshot) => {
        const state = snapshot.val();
        if (state) {
            // Update who touched it last
            lastBroadcaster = state.lastUpdater; 
            
            if (state.lastUpdater !== myName) {
                applyRemoteCommand(state);
            }
        }
        updateSyncStatus();
    });

    chatRef.limitToLast(50).on('child_added', (snapshot) => {
        const msg = snapshot.val();
        displayChatMessage(msg.user, msg.text, msg.timestamp);
    });
}
loadInitialData();

function addToQueue(videoId, title, uploader, thumbnail) {
    const newKey = queueRef.push().key;
    queueRef.child(newKey).set({ videoId, title, uploader, thumbnail, addedBy: myName, order: Date.now() })
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0) loadAndPlayVideo(videoId, title, uploader);
        });
}

function addBatchToQueue(songs) {
    if (!songs.length) return;
    const updates = {};
    songs.forEach((s, i) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...s, addedBy: myName, order: Date.now() + i * 100 };
    });
    queueRef.update(updates).then(() => switchTab('queue'));
}

function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    const song = currentQueue.find(s => s.key === key);
    if (song) {
        queueRef.child(key).remove();
        if (song.videoId === currentVideoId) playNextSong();
    }
}

function updateQueueOrder(newOrder) {
    const updates = {};
    newOrder.forEach((song, index) => { updates[`${song.key}/order`] = index; });
    queueRef.update(updates);
}

function playNextSong() {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    const next = currentQueue[(idx + 1) % currentQueue.length];
    if (next) loadAndPlayVideo(next.videoId, next.title, next.uploader);
}

// --- UI RENDER ---
function renderQueue(queueArray, currentVideoId) {
    const list = document.getElementById('queue-list');
    list.innerHTML = '';
    document.getElementById('queue-count').textContent = queueArray.length;

    if (queueArray.length === 0) {
        list.innerHTML = '<p style="text-align:center; padding:20px; color:#fff; font-size:1rem;">Queue is empty.</p>';
        return;
    }

    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.draggable = true;
        item.dataset.key = song.key;
        item.onclick = () => loadAndPlayVideo(song.videoId, song.title, song.uploader);
        
        const subtitle = `Added by ${song.addedBy || 'System'}`;
        const number = index + 1;
        
        // MOVED DRAG HANDLE TO THE LEFT
        item.innerHTML = `
            <i class="fa-solid fa-bars drag-handle" title="Drag to order"></i>
            <div class="song-index">${number}</div>
            <img src="${song.thumbnail}" class="song-thumb">
            <div class="song-details"><h4>${song.title}</h4><p>${subtitle}</p></div>
            <button class="emoji-trigger" onclick="removeFromQueue('${song.key}', event)"><i class="fa-solid fa-trash"></i></button>
        `;
        list.appendChild(item);
    });

    initDragAndDrop(list);
}

function initDragAndDrop(list) {
    let draggedItem = null;
    list.querySelectorAll('.song-item').forEach(item => {
        item.addEventListener('dragstart', () => { draggedItem = item; item.classList.add('dragging'); });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
            draggedItem = null;
            const newOrderKeys = Array.from(list.querySelectorAll('.song-item')).map(el => el.dataset.key);
            const newOrder = newOrderKeys.map(key => currentQueue.find(s => s.key === key));
            updateQueueOrder(newOrder);
        });
        item.addEventListener('dragover', (e) => {
            e.preventDefault();
            const afterElement = getDragAfterElement(list, e.clientY);
            if (afterElement == null) list.appendChild(draggedItem);
            else list.insertBefore(draggedItem, afterElement);
        });
    });
}

function getDragAfterElement(container, y) {
    const draggableElements = [...container.querySelectorAll('.song-item:not(.dragging)')];
    return draggableElements.reduce((closest, child) => {
        const box = child.getBoundingClientRect();
        const offset = y - box.top - box.height / 2;
        if (offset < 0 && offset > closest.offset) return { offset: offset, element: child };
        else return closest;
    }, { offset: Number.NEGATIVE_INFINITY }).element;
}

// --- SEARCH ---
async function handleSearch() {
    const input = document.getElementById('searchInput');
    const query = input.value.trim();
    if (!query) return;

    if (query.includes('list=')) {
        const listId = query.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        input.value = ''; return;
    }
    if (query.includes('spotify.com')) {
        fetchSpotifyData(query);
        input.value = ''; return;
    }

    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p style="text-align:center; padding:20px; color:white;">Searching...</p>';
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`;
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        const list = document.getElementById('results-list');
        list.innerHTML = '';
        data.items.forEach(item => {
            const div = document.createElement('div');
            div.className = 'song-item';
            div.innerHTML = `
                <img src="${item.snippet.thumbnails.default.url}" class="song-thumb">
                <div class="song-details"><h4>${item.snippet.title}</h4><p>${item.snippet.channelTitle}</p></div>
                <button class="emoji-trigger" style="color:#fff; font-size:1.1rem; position:static; width:auto; height:auto; border:none; background:transparent;"><i class="fa-solid fa-plus"></i></button>
            `;
            div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.channelTitle, item.snippet.thumbnails.default.url);
            list.appendChild(div);
        });
    } catch(e) { console.error(e); }
    input.value = '';
}

async function fetchPlaylist(playlistId, pageToken = '', allSongs = []) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}&pageToken=${pageToken}`;
    try {
        const res = await fetch(url);
        const data = await res.json();
        const songs = data.items.filter(i=>i.snippet.resourceId.kind==='youtube#video').map(i => ({
            videoId: i.snippet.resourceId.videoId,
            title: i.snippet.title, uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url
        }));
        allSongs = [...allSongs, ...songs];
        if (data.nextPageToken) fetchPlaylist(playlistId, data.nextPageToken, allSongs);
        else addBatchToQueue(allSongs);
    } catch(e) { console.error(e); }
}

async function fetchSpotifyData(link) {
    const proxy = `https://spotify-proxy.vercel.app/api/data?url=${encodeURIComponent(link)}`;
    try {
        const res = await fetch(proxy);
        const data = await res.json();
        if(data.tracks) {
            const songs = [];
            for (const t of data.tracks.slice(0, 10)) { 
                const sRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(t.artist + ' ' + t.title)}&type=video&maxResults=1&key=${YOUTUBE_API_KEY}`);
                const sData = await sRes.json();
                if(sData.items.length) {
                    const i = sData.items[0];
                    songs.push({ videoId: i.id.videoId, title: i.snippet.title, uploader: i.snippet.channelTitle, thumbnail: i.snippet.thumbnails.default.url });
                }
            }
            addBatchToQueue(songs);
        }
    } catch(e) { console.error(e); }
}

// --- CHAT ---
function displayChatMessage(user, text, timestamp) {
    const box = document.getElementById('chat-messages');
    const isMe = user === myName;
    const div = document.createElement('div');
    div.className = `message ${isMe ? 'me' : 'partner'}`;
    const time = new Date(timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
    div.innerHTML = `<div class="msg-header">${user} <span style="font-size:0.85em;">${time}</span></div>${text}`;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
}

document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
document.getElementById('prev-btn').addEventListener('click', () => {
    const idx = currentQueue.findIndex(s => s.videoId === currentVideoId);
    if(idx > 0) loadAndPlayVideo(currentQueue[idx-1].videoId, currentQueue[idx-1].title, currentQueue[idx-1].uploader);
});
document.getElementById('next-btn').addEventListener('click', playNextSong);

document.getElementById('search-btn').addEventListener('click', handleSearch);
document.getElementById('searchInput').addEventListener('keypress', (e) => { if(e.key==='Enter') handleSearch(); });

document.getElementById('chatSendBtn').addEventListener('click', () => {
    const val = document.getElementById('chatInput').value.trim();
    if(val) { chatRef.push({ user: myName, text: val, timestamp: Date.now() }); document.getElementById('chatInput').value=''; }
});
document.getElementById('chatInput').addEventListener('keypress', (e) => {
    if(e.key === 'Enter') document.getElementById('chatSendBtn').click();
});

document.getElementById('nativeEmojiBtn').addEventListener('click', () => {
    document.getElementById('chatInput').focus();
});

document.getElementById('tab-queue').addEventListener('click', () => switchTab('queue'));
document.getElementById('tab-results').addEventListener('click', () => switchTab('results'));
document.getElementById('clearQueueBtn').addEventListener('click', () => { if(confirm("Clear the entire queue?")) queueRef.remove(); });
document.getElementById('forceSyncBtn').addEventListener('click', () => {
    document.getElementById('syncOverlay').classList.remove('active');
    player.playVideo(); broadcastState('play', player.getCurrentTime(), currentVideoId);
});
document.getElementById('infoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.add('active'));
document.getElementById('closeInfoBtn').addEventListener('click', () => document.getElementById('infoOverlay').classList.remove('active'));

function switchTab(tab) {
    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.getElementById('tab-'+tab).classList.add('active');
    document.getElementById('queue-list').style.display = tab==='queue'?'block':'none';
    document.getElementById('results-list').style.display = tab==='results'?'block':'none';
}

function broadcastState(action, time, videoId) {
    syncRef.set({ 
        action, 
        time, 
        videoId, 
        lastUpdater: myName, 
        timestamp: Date.now() 
    });
}

function applyRemoteCommand(state, initialLoad = false) {
    if (!player) return;
    
    isPartnerPlaying = true;
    document.getElementById('syncOverlay').classList.remove('active');

    if (state.videoId !== currentVideoId) {
        const songInQueue = currentQueue.find(s => s.videoId === state.videoId);
        const title = songInQueue ? songInQueue.title : "Syncing Song...";
        const uploader = songInQueue ? songInQueue.uploader : "";
        loadAndPlayVideo(state.videoId, title, uploader, state.time);
        
        if(state.action === 'play') player.playVideo();
    } 
    else {
        const playerState = player.getPlayerState();
        
        if (state.action === 'pause') {
            if (playerState !== YT.PlayerState.PAUSED) player.pauseVideo();
        } 
        else if (state.action === 'ad_pause') {
            const msg = document.getElementById('sync-status-msg');
            msg.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Partner has Ad`;
            msg.style.background = "#ff9800"; 
            if (playerState !== YT.PlayerState.PAUSED) player.pauseVideo();
        } 
        else if (state.action === 'play') {
            const timeDiff = Math.abs(player.getCurrentTime() - state.time);
            if (timeDiff > 1.5) player.seekTo(state.time, true);
            if (playerState !== YT.PlayerState.PLAYING) player.playVideo();
        }
    }

    setTimeout(() => { isPartnerPlaying = false; }, 1000);
}

function updateSyncStatus() {
    const msg = document.getElementById('sync-status-msg');
    
    if (player && player.getPlayerState() === YT.PlayerState.PLAYING) {
        msg.innerHTML = `<i class="fa-solid fa-heart-pulse"></i> Synced`;
        msg.style.background = "#ffd700"; // Gold
        msg.style.color = "#000";
    } else {
        if (!msg.innerHTML.includes("Ad")) {
            // Determine who paused it based on lastBroadcaster
            const pausedBy = (lastBroadcaster === myName) ? "You" : lastBroadcaster;
            const displayText = (lastBroadcaster === "System") ? "Paused" : `Paused by ${pausedBy}`;
            
            msg.innerHTML = `<i class="fa-solid fa-pause"></i> ${displayText}`;
            msg.style.background = "#444";
            msg.style.color = "#fff";
        }
    }
}
