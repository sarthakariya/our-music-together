// --- CONFIGURATION ---
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68"; // From prompt
const FIREBASE_CONFIG = {
    apiKey: "AIzaSyDeu4lRYAmlxb4FLC9sNaj9GwgpmZ5T5Co",
    authDomain: "our-music-player.firebaseapp.com",
    databaseURL: "https://our-music-player-default-rtdb.asia-southeast1.firebasedatabase.app",
    projectId: "our-music-player",
    storageBucket: "our-music-player.firebasestorage.app",
    messagingSenderId: "444208622552",
    appId: "1:444208622552:web:839ca00a5797f52d1660ad",
    measurementId: "G-B4GFLNFCLL"
};

// --- STATE MANAGEMENT ---
const state = {
    userName: null,
    currentSong: null,
    isPlaying: false,
    queue: [],
    searchResults: [],
    activeView: 'queue', // 'queue' or 'results'
    playerReady: false,
    isRemoteUpdate: false // Prevent echo loops
};

// --- FIREBASE INIT ---
firebase.initializeApp(FIREBASE_CONFIG);
const db = firebase.database();
const refs = {
    sync: db.ref('sync'),
    queue: db.ref('queue'),
    chat: db.ref('chat')
};

// --- DOM ELEMENTS ---
const dom = {
    playBtn: document.getElementById('play-btn'),
    prevBtn: document.getElementById('prev-btn'),
    nextBtn: document.getElementById('next-btn'),
    playerOverlay: document.getElementById('player-overlay'),
    title: document.getElementById('current-title'),
    artist: document.getElementById('current-artist'),
    statusBadge: document.getElementById('status-badge'),
    statusText: document.getElementById('status-text'),
    statusIcon: document.querySelector('#status-badge i'),
    
    // List & Search
    listContainer: document.getElementById('list-container'),
    searchForm: document.getElementById('search-form'),
    searchInput: document.getElementById('search-input'),
    subtabQueue: document.getElementById('subtab-queue'),
    subtabResults: document.getElementById('subtab-results'),
    queueCount: document.getElementById('queue-count'),
    clearQueueBtn: document.getElementById('clear-queue-btn'),
    
    // Chat
    chatMessages: document.getElementById('chat-messages'),
    chatForm: document.getElementById('chat-form'),
    chatInput: document.getElementById('chat-input'),
    
    // Mobile Tabs
    tabQueue: document.getElementById('tab-queue'),
    tabChat: document.getElementById('tab-chat'),
    queueView: document.getElementById('queue-view'),
    chatView: document.getElementById('chat-view'),
    
    // Modal
    infoBtn: document.getElementById('info-btn'),
    infoModal: document.getElementById('info-modal'),
    closeModalBtn: document.getElementById('close-modal-btn'),
    modalActionBtn: document.getElementById('modal-action-btn')
};

// --- INITIALIZATION ---
let player; // YouTube Player Instance

function initApp() {
    let storedName = localStorage.getItem('heartRhythmUser');
    if (!storedName) {
        storedName = prompt("Enter your name (Sarthak or Reechita):") || "Guest";
        localStorage.setItem('heartRhythmUser', storedName);
    }
    state.userName = storedName;
    
    // Listeners
    setupFirebaseListeners();
    setupDOMListeners();
}

// --- PLAYER LOGIC ---
window.onYouTubeIframeAPIReady = function() {
    player = new YT.Player('youtube-player', {
        height: '100%',
        width: '100%',
        playerVars: {
            'controls': 0,
            'disablekb': 1,
            'rel': 0,
            'modestbranding': 1,
            'autoplay': 0,
            'origin': window.location.origin
        },
        events: {
            'onReady': onPlayerReady,
            'onStateChange': onPlayerStateChange
        }
    });
};

function onPlayerReady(event) {
    state.playerReady = true;
    event.target.setVolume(85);
    updateStatus('Ready', false);
}

function onPlayerStateChange(event) {
    const s = event.data;
    const currentTime = player.getCurrentTime();
    
    // PLAYING
    if (s === YT.PlayerState.PLAYING) {
        updatePlayButton(true);
        if (!state.isRemoteUpdate) {
            broadcastSync('play', currentTime);
        }
        state.isRemoteUpdate = false;
    }
    // PAUSED
    else if (s === YT.PlayerState.PAUSED) {
        updatePlayButton(false);
        if (!state.isRemoteUpdate) {
            broadcastSync('pause', currentTime);
        }
        state.isRemoteUpdate = false;
    }
    // ENDED
    else if (s === YT.PlayerState.ENDED) {
        playNext();
    }
}

function broadcastSync(action, time) {
    if (!state.currentSong) return;
    refs.sync.set({
        action: action,
        time: time,
        videoId: state.currentSong.videoId,
        lastUpdater: state.userName,
        timestamp: Date.now()
    });
}

// --- SYNC LOGIC ---
function handleSyncUpdate(data) {
    if (!data || !player || !state.playerReady) return;

    const partnerName = state.userName.toLowerCase().includes('sarthak') ? 'Reechita' : 'Sarthak';
    
    // Update visual status
    if (data.action === 'play') {
        updateStatus('Synced & Playing', true);
    } else {
        updateStatus('Paused', false);
    }

    // Ignore own updates
    if (data.lastUpdater === state.userName) return;

    state.isRemoteUpdate = true; // Flag to prevent loop

    const playerState = player.getPlayerState();

    // 1. Check Song Change
    if (state.currentSong?.videoId !== data.videoId) {
        // Find song in queue to get details
        const found = state.queue.find(s => s.videoId === data.videoId);
        if (found) {
            loadSong(found);
        } else {
            // If not in queue (rare), just load ID
            // Ideally we wait for queue sync, but for strict sync:
            // We might just need to rely on the queue listener updating state.currentSong
        }
    }

    // 2. Sync Time (Strict: tolerance 1.5s)
    const currentTime = player.getCurrentTime();
    const timeDiff = Math.abs(currentTime - data.time);
    
    if (timeDiff > 1.5) {
        player.seekTo(data.time, true);
    }

    // 3. Sync State
    if (data.action === 'play' && playerState !== YT.PlayerState.PLAYING) {
        player.playVideo();
    } else if (data.action === 'pause' && playerState !== YT.PlayerState.PAUSED) {
        player.pauseVideo();
    }
}

function loadSong(song) {
    if (state.currentSong?.videoId === song.videoId) return;
    
    state.currentSong = song;
    dom.title.textContent = song.title;
    dom.artist.textContent = song.uploader;
    
    if (player && state.playerReady) {
        state.isRemoteUpdate = true; // Loading new song acts like a stop
        player.loadVideoById(song.videoId);
        updateStatus(`Playing: ${song.title}`, true);
        // Highlight in queue
        renderQueue(); 
    }
}

function togglePlay() {
    if (!player || !state.playerReady) return;
    const ps = player.getPlayerState();
    if (ps === YT.PlayerState.PLAYING) {
        player.pauseVideo();
    } else {
        player.playVideo();
    }
}

function playNext() {
    if (!state.currentSong || state.queue.length === 0) return;
    const idx = state.queue.findIndex(s => s.videoId === state.currentSong.videoId);
    if (idx >= 0 && idx < state.queue.length - 1) {
        const next = state.queue[idx + 1];
        // Broadcasting play logic handled by player state change or manual update?
        // Better to update sync directly to switch for everyone
        refs.sync.update({
            videoId: next.videoId,
            action: 'play',
            time: 0,
            lastUpdater: state.userName,
            timestamp: Date.now()
        });
    }
}

function playPrev() {
    if (!state.currentSong || state.queue.length === 0) return;
    const idx = state.queue.findIndex(s => s.videoId === state.currentSong.videoId);
    if (idx > 0) {
        const prev = state.queue[idx - 1];
        refs.sync.update({
            videoId: prev.videoId,
            action: 'play',
            time: 0,
            lastUpdater: state.userName,
            timestamp: Date.now()
        });
    }
}

// --- QUEUE & SEARCH ---
function setupFirebaseListeners() {
    // Sync
    refs.sync.on('value', snap => handleSyncUpdate(snap.val()));
    
    // Queue
    refs.queue.orderByChild('order').on('value', snap => {
        const data = snap.val();
        state.queue = [];
        if (data) {
            Object.keys(data).forEach(key => {
                state.queue.push({ ...data[key], key });
            });
            state.queue.sort((a, b) => a.order - b.order);
        }
        
        // If no song playing, maybe load first?
        if (!state.currentSong && state.queue.length > 0) {
             // Wait for sync event usually, but if idle:
             // loadSong(state.queue[0]); // Optional auto-load
        }
        
        dom.queueCount.textContent = `(${state.queue.length})`;
        if (state.activeView === 'queue') renderQueue();
    });

    // Chat
    refs.chat.limitToLast(50).on('child_added', snap => {
        renderMessage({ ...snap.val(), key: snap.key });
    });
}

function renderQueue() {
    dom.listContainer.innerHTML = '';
    if (state.queue.length === 0) {
        dom.listContainer.innerHTML = '<div class="text-center text-gray-500 mt-10 text-sm">queue is empty, add some love songs...</div>';
        dom.clearQueueBtn.classList.add('hidden');
        return;
    }
    
    dom.clearQueueBtn.classList.remove('hidden');

    state.queue.forEach(song => {
        const isCurrent = state.currentSong && state.currentSong.videoId === song.videoId;
        const el = document.createElement('div');
        el.className = `group flex items-center gap-3 p-2 rounded-lg border border-transparent transition-all hover:bg-white/5 hover:border-white/10 ${isCurrent ? 'bg-gradient-to-r from-[#ff0a78]/20 to-transparent border-l-2 border-l-[#ff0a78]' : ''}`;
        
        el.innerHTML = `
            <img src="${song.thumbnail}" class="w-10 h-10 rounded object-cover" loading="lazy">
            <div class="flex-1 min-w-0">
                <h4 class="text-sm font-medium truncate ${isCurrent ? 'text-[#ff0a78]' : 'text-gray-200'}">${song.title}</h4>
                <p class="text-xs text-gray-500 truncate">${song.uploader}</p>
            </div>
            <button class="remove-btn opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-400 p-2">
                <i class="fa-solid fa-trash text-xs"></i>
            </button>
        `;
        
        el.querySelector('.remove-btn').onclick = () => {
            if(confirm('Remove this song?')) refs.queue.child(song.key).remove();
        };

        dom.listContainer.appendChild(el);
    });
}

async function handleSearch(e) {
    e.preventDefault();
    const q = dom.searchInput.value.trim();
    if (!q) return;

    dom.listContainer.innerHTML = '<div class="text-center p-4 text-[#00f2ea] animate-pulse">Searching the cosmos...</div>';
    state.activeView = 'results';
    updateTabUI();

    try {
        const res = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=10&key=${YOUTUBE_API_KEY}`);
        const data = await res.json();
        state.searchResults = data.items || [];
        renderSearchResults();
    } catch (err) {
        console.error(err);
        dom.listContainer.innerHTML = '<div class="text-center text-red-400">Search failed.</div>';
    }
}

function renderSearchResults() {
    dom.listContainer.innerHTML = '';
    state.searchResults.forEach(item => {
        const el = document.createElement('div');
        el.className = 'flex items-center gap-3 p-2 rounded-lg hover:bg-white/5 cursor-pointer';
        el.innerHTML = `
            <img src="${item.snippet.thumbnails.default.url}" class="w-12 h-12 rounded object-cover">
            <div class="flex-1 min-w-0">
                <h4 class="text-sm font-medium text-white truncate">${item.snippet.title}</h4>
                <p class="text-xs text-gray-500">${item.snippet.channelTitle}</p>
            </div>
            <i class="fa-solid fa-plus text-[#00f2ea]"></i>
        `;
        el.onclick = () => {
            const newSong = {
                videoId: item.id.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url,
                order: Date.now()
            };
            refs.queue.push(newSong);
            state.activeView = 'queue';
            dom.searchInput.value = '';
            updateTabUI();
        };
        dom.listContainer.appendChild(el);
    });
}

// --- CHAT ---
function renderMessage(msg) {
    const isMe = msg.user === state.userName;
    const el = document.createElement('div');
    el.className = `flex flex-col ${isMe ? 'items-end' : 'items-start'}`;
    
    // Bold Font 'Play' for user name
    const nameColor = isMe ? 'text-[#ff0a78]' : 'text-[#00f2ea]';
    const bubbleStyle = isMe 
        ? 'bg-gradient-to-br from-[#ff0a78] to-[#ff5e9a] text-white rounded-tr-none' 
        : 'bg-white/10 border border-white/10 text-gray-200 rounded-tl-none backdrop-blur-md';

    el.innerHTML = `
        <span class="text-xs mb-1 font-['Play'] font-bold uppercase tracking-widest ${nameColor}">
            ${msg.user}
        </span>
        <div class="max-w-[85%] px-4 py-2 rounded-2xl text-sm leading-relaxed shadow-md break-words ${bubbleStyle}">
            ${msg.text}
        </div>
    `;
    
    dom.chatMessages.appendChild(el);
    dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
}

function sendMessage(e) {
    e.preventDefault();
    const text = dom.chatInput.value.trim();
    if (!text) return;
    
    refs.chat.push({
        user: state.userName,
        text: text,
        timestamp: Date.now()
    });
    dom.chatInput.value = '';
}

// --- UI HELPERS ---
function updateStatus(text, isPlaying) {
    dom.statusText.textContent = text;
    dom.statusBadge.className = `inline-flex items-center gap-2 px-4 py-1 rounded-full text-sm font-bold tracking-wider transition-all duration-300 ${
        isPlaying || text.includes('Ad') 
        ? 'text-[#00f2ea] bg-[#00f2ea]/10 border border-[#00f2ea]/20' 
        : 'text-yellow-300 bg-yellow-500/10 border border-yellow-500/20'
    }`;
    dom.statusIcon.className = isPlaying ? "fa-solid fa-bolt animate-pulse" : "fa-solid fa-pause";
}

function updatePlayButton(isPlaying) {
    if (isPlaying) {
        dom.playBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        dom.playBtn.classList.replace('bg-[#ff0a78]', 'bg-gray-800');
        dom.playBtn.classList.replace('text-white', 'text-[#ff0a78]');
        dom.playBtn.classList.add('border-[#ff0a78]');
    } else {
        dom.playBtn.innerHTML = '<i class="fa-solid fa-play pl-1"></i>';
        dom.playBtn.classList.replace('bg-gray-800', 'bg-[#ff0a78]');
        dom.playBtn.classList.replace('text-[#ff0a78]', 'text-white');
        dom.playBtn.classList.remove('border-[#ff0a78]');
    }
}

function updateTabUI() {
    if (state.activeView === 'queue') {
        dom.subtabQueue.classList.replace('border-transparent', 'border-[#00f2ea]');
        dom.subtabQueue.classList.replace('text-gray-500', 'text-white');
        dom.subtabResults.classList.replace('border-[#00f2ea]', 'border-transparent');
        dom.subtabResults.classList.replace('text-white', 'text-gray-500');
        renderQueue();
    } else {
        dom.subtabResults.classList.replace('border-transparent', 'border-[#00f2ea]');
        dom.subtabResults.classList.replace('text-gray-500', 'text-white');
        dom.subtabQueue.classList.replace('border-[#00f2ea]', 'border-transparent');
        dom.subtabQueue.classList.replace('text-white', 'text-gray-500');
    }
}

function setupDOMListeners() {
    // Controls
    dom.playBtn.onclick = togglePlay;
    dom.playerOverlay.onclick = togglePlay;
    dom.nextBtn.onclick = playNext;
    dom.prevBtn.onclick = playPrev;

    // Search & Queue
    dom.searchForm.onsubmit = handleSearch;
    dom.clearQueueBtn.onclick = () => { if(confirm('Clear all?')) refs.queue.remove(); };
    dom.subtabQueue.onclick = () => { state.activeView = 'queue'; updateTabUI(); };
    dom.subtabResults.onclick = () => { state.activeView = 'results'; updateTabUI(); };

    // Chat
    dom.chatForm.onsubmit = sendMessage;

    // Mobile Tabs
    dom.tabQueue.onclick = () => {
        dom.tabQueue.classList.add('text-[#ff0a78]', 'bg-white/5');
        dom.tabQueue.classList.remove('text-gray-500');
        dom.tabChat.classList.remove('text-[#00f2ea]', 'bg-white/5');
        dom.tabChat.classList.add('text-gray-500');
        dom.queueView.classList.remove('hidden');
        dom.chatView.classList.add('hidden');
        // Ensure queue flex is correct
        dom.queueView.style.display = 'flex';
        dom.chatView.style.display = 'none';
    };
    dom.tabChat.onclick = () => {
        dom.tabChat.classList.add('text-[#00f2ea]', 'bg-white/5');
        dom.tabChat.classList.remove('text-gray-500');
        dom.tabQueue.classList.remove('text-[#ff0a78]', 'bg-white/5');
        dom.tabQueue.classList.add('text-gray-500');
        dom.chatView.classList.remove('hidden');
        dom.queueView.classList.add('hidden');
         // Ensure chat flex is correct
        dom.chatView.style.display = 'flex';
        dom.queueView.style.display = 'none';
    };

    // Modal
    const toggleModal = (show) => {
        if (show) dom.infoModal.classList.add('modal-show');
        else dom.infoModal.classList.remove('modal-show');
    };
    dom.infoBtn.onclick = () => toggleModal(true);
    dom.closeModalBtn.onclick = () => toggleModal(false);
    dom.modalActionBtn.onclick = () => toggleModal(false);
}

// Start
initApp();
