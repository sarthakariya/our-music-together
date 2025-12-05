// ================= CONFIGURATION =================
// NOTE: Please replace these with your actual keys and domains.
const firebaseConfig = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad"
};
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

firebase.initializeApp(firebaseConfig);
const db = firebase.database().ref('session_v5');
const chatRef = firebase.database().ref('chat_log');

// Variables
let player;
let queue = [];
let currentIndex = 0;
let lastKnownTime = 0;
let lastSkipCmd = 0;
let isDragging = false;
let myName = "Guest"; // Default, will be set by identifyUser()

// DOM Elements
const dom = {
    player: document.getElementById('player'),
    playBtn: document.getElementById('play-pause-btn'),
    title: document.getElementById('current-song-title'),
    seek: document.getElementById('seek-bar'),
    progress: document.getElementById('seek-progress'),
    curr: document.getElementById('current-time'),
    dur: document.getElementById('duration'),
    overlay: document.getElementById('syncOverlay'),
    searchIn: document.getElementById('searchInput'),
    resList: document.getElementById('results-list'),
    qList: document.getElementById('queue-list'),
    qCount: document.getElementById('queue-count'),
    chatIn: document.getElementById('chatInput'),
    chatBox: document.getElementById('chat-messages')
};

// ================= YOUTUBE API & INIT =================

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%', width: '100%',
        videoId: 'bTqVqk7FSmY',
        playerVars: { 
            'playsinline': 1, 'controls': 0, 'rel': 0, 'fs': 0, 'iv_load_policy': 3, 'disablekb': 1 
        },
        events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
    });
}
var tag = document.createElement('script'); tag.src = "https://www.youtube.com/iframe_api";
document.body.appendChild(tag);

function identifyUser() {
    let name = prompt("Please enter your name for chat: Sarthak or Reechita/Mammam");
    if (name) {
        name = name.trim();
        if (name.toLowerCase().includes('sarthak')) {
            myName = "Sarthak";
        } else if (name.toLowerCase().includes('reechita') || name.toLowerCase().includes('mammam')) {
            myName = "Mammam";
        } else {
            myName = name; // Allows for any name if they don't use the standard two
        }
        dom.chatBox.innerHTML += `<div class="chat-message system">You are logged in as **${myName}**.</div>`;
    }
}

function onPlayerReady() {
    identifyUser(); // NEW: Ask for name first
    initSync();
    initChatListener();
    
    // UI Loop
    setInterval(updateUI, 500);
    // Master Status Check Loop
    setInterval(checkPlaybackStatus, 1000);
}

function onPlayerStateChange(e) {
    if (e.data === 0) playNext();
}


// ================= V5: STRICT SYNCHRONIZATION PROTOCOL =================
// (Logic remains the same, ensuring strict enforcement)

function initSync() {
    db.on('value', snap => {
        const data = snap.val();
        if (!data) return;

        queue = data.queue || [];
        currentIndex = data.index || 0;
        renderQueue();

        if (queue.length > 0) {
            const song = queue[currentIndex];
            
            if (player.getVideoData().video_id !== song.id) {
                player.loadVideoById(song.id);
                dom.title.innerText = song.title;
            }

            if (data.adDetected) {
                if(player.getPlayerState() !== 2) player.pauseVideo();
                if(!dom.overlay.classList.contains('active')) dom.overlay.classList.add('active');
            } else {
                
                const serverStatus = data.status;
                const serverTime = data.time || 0;
                const skipCmd = data.skipCmd || 0;

                dom.overlay.classList.remove('active');
                
                if (serverStatus === 'playing') {
                    if (player.getPlayerState() !== 1) player.playVideo();
                    dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
                } else {
                    if (player.getPlayerState() === 1) player.pauseVideo();
                    dom.playBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
                }

                if (skipCmd > lastSkipCmd) {
                    player.seekTo(serverTime, true);
                    lastSkipCmd = skipCmd;
                }
                else if (Math.abs(player.getCurrentTime() - serverTime) > 3) {
                    player.seekTo(serverTime, true);
                }
            }
        }
    });
}

function checkPlaybackStatus() {
    if (!player || queue.length === 0) return;
    
    const state = player.getPlayerState();
    const curr = player.getCurrentTime();

    if (state === 1) {
        if (Math.abs(curr - lastKnownTime) < 0.1) {
            db.update({ adDetected: true, status: 'paused' });
        } else {
            lastKnownTime = curr;
            db.update({ time: curr, adDetected: false });
        }
    }
}

window.togglePlay = function() {
    if (queue.length === 0) return;
    db.once('value', snap => {
        const status = snap.val()?.status;
        db.update({ status: status === 'playing' ? 'paused' : 'playing' });
    });
}

window.forceSyncResume = function() {
    db.update({ 
        skipCmd: Date.now(),
        adDetected: false,
        time: player.getCurrentTime() + 1,
        status: 'playing'
    });
}

// ================= QUEUE & PAGINATED PLAYLIST LOGIC =================
// (This ensures search works and playlist loading is robust)

window.manualSearch = function() { // Made global for button click
    const q = dom.searchIn.value;
    if (!q) return;

    if (q.includes('list=')) {
        const listId = q.split('list=')[1].split('&')[0];
        fetchPlaylist(listId);
        return;
    }

    if (q.includes('v=')) {
        const id = q.split('v=')[1].split('&')[0];
        addToQueue(id, "Shared Link", `https://img.youtube.com/vi/${id}/default.jpg`);
        return;
    }

    searchYouTube(q);
    switchTab('results');
}

async function fetchPlaylist(listId, pageToken = null) {
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${listId}&key=${YOUTUBE_API_KEY}` +
                (pageToken ? `&pageToken=${pageToken}` : '');
    
    try {
        const res = await fetch(url);
        const data = await res.json();
        
        if (data.items) {
            const newSongs = data.items.map(item => ({
                id: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                thumb: item.snippet.thumbnails.default.url
            }));
            
            queue = [...queue, ...newSongs];
            
            if (data.nextPageToken) {
                dom.title.innerText = `Loading... ${queue.length} songs so far.`;
                await fetchPlaylist(listId, data.nextPageToken);
                return;
            }
            
            db.update({ queue: queue });
            if (currentIndex === 0) {
                 db.update({ index: 0, status: 'playing' });
            }
            dom.searchIn.value = '';
            switchTab('queue');
        }
    } catch(e) {
        alert("Could not load playlist. API Quota might be exceeded or link invalid.");
    }
}

async function searchYouTube(q) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&maxResults=10&q=${q}&type=video&key=${YOUTUBE_API_KEY}`;
    const res = await fetch(url);
    const data = await res.json();
    
    dom.resList.innerHTML = '';
    data.items.forEach(item => {
        const div = document.createElement('div');
        div.className = 'song-item';
        div.innerHTML = `
            <img src="${item.snippet.thumbnails.default.url}" class="thumb">
            <div class="meta"><h4>${item.snippet.title}</h4></div>
            <button class="add-btn"><i class="fa-solid fa-plus"></i></button>
        `;
        div.onclick = () => addToQueue(item.id.videoId, item.snippet.title, item.snippet.thumbnails.default.url);
        dom.resList.appendChild(div);
    });
}

function addToQueue(id, title, thumb) {
    const newQueue = [...queue, { id, title, thumb }];
    if (queue.length === 0) {
        db.update({ queue: newQueue, index: 0, status: 'playing', time: 0 });
    } else {
        db.update({ queue: newQueue });
    }
    dom.searchIn.value = '';
    switchTab('queue');
}

// ================= LIVE CHAT =================

function initChatListener() {
    chatRef.on('child_added', snap => {
        const msg = snap.val();
        renderMessage(msg.user, msg.message, msg.timestamp);
    });
}

window.sendMessage = function() {
    const text = dom.chatIn.value.trim();
    if (text) {
        chatRef.push({
            user: myName,
            message: text,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        dom.chatIn.value = '';
    }
}

function renderMessage(user, message, timestamp) {
    const div = document.createElement('div');
    const senderClass = (user === myName) ? 'me' : 'partner';
    
    // Ensure 'Mammam' is identified as the partner correctly by Sarthak
    const partnerIsMammam = myName === "Sarthak" && user === "Mammam";

    div.className = `chat-message ${senderClass}`;
    if(user === "Sarthak" || partnerIsMammam) {
        // Use bold for the name if it's Sarthak or Mammam
        div.className += ' known-user'; 
    }
    
    const date = new Date(timestamp);
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
        <p><strong>${user}:</strong> ${message}</p>
        <small>${timeStr}</small>
    `;
    dom.chatBox.appendChild(div);
    dom.chatBox.scrollTop = dom.chatBox.scrollHeight;
}

// ================= UI HELPERS =================
// (Other helper functions like renderQueue, switchTab, formatTime remain the same)

window.syncSeek = function(seconds) {
    const newTime = player.getCurrentTime() + seconds;
    player.seekTo(newTime, true);
    db.update({ time: newTime });
}

window.playNext = function() {
    if (currentIndex < queue.length - 1) {
        db.update({ index: currentIndex + 1, time: 0, status: 'playing' });
    }
}

window.playPrev = function() {
    if (currentIndex > 0) {
        db.update({ index: currentIndex - 1, time: 0, status: 'playing' });
    }
}

window.addToQueue = addToQueue;

window.renderQueue = function() {
    dom.qCount.innerText = `${queue.length} Songs`;
    dom.qList.innerHTML = '';
    if(queue.length === 0) dom.qList.innerHTML = '<div class="empty-state">Queue is empty</div>';
    
    queue.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = `song-item ${idx === currentIndex ? 'playing' : ''}`;
        div.innerHTML = `
            <img src="${song.thumb}" class="thumb">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>${idx === currentIndex ? 'NOW PLAYING' : ''}</p>
            </div>
            <button onclick="deleteSong(event, ${idx})" class="del-btn"><i class="fa-solid fa-xmark"></i></button>
        `;
        div.onclick = (e) => {
            if(!e.target.closest('.del-btn')) db.update({ index: idx, status: 'playing', time: 0 });
        }
        dom.qList.appendChild(div);
    });
}
