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

if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// --- USER IDENTIFICATION ---
let myName = "Sarthak";
const storedName = localStorage.getItem('deepSpaceUserName');
if (storedName) {
    myName = storedName;
} else {
    // If Reechita registers first
    const enteredName = prompt("Welcome to Deep Space Sync! Please enter your name (Sarthak or Partner's Name):");
    if (enteredName && enteredName.trim() !== "") {
        myName = enteredName.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}

// Fixed DB Paths
const fixedDBName = (myName.toLowerCase() === "sarthak") ? "Sarthak" : "Reechita"; 
const fixedPartnerName = (fixedDBName === "Sarthak") ? "Reechita" : "Sarthak";

// References
const queueRef = db.ref('queue');
const myRootRef = db.ref(`users/${fixedDBName}`);
const mySyncRef = myRootRef.child('sync');
const myChatRef = myRootRef.child('chat');

const partnerRootRef = db.ref(`users/${fixedPartnerName}`);
const partnerSyncRef = partnerRootRef.child('sync');
const partnerChatRef = partnerRootRef.child('chat');

const syncRef = mySyncRef;
const chatRef = myChatRef; 

// Global State
let player; 
let currentQueue = [];
let currentSearchResults = [];
let currentVideoId = null;
let isPartnerPlaying = false; 
let lastBroadcaster = "System";
let isManualAction = false; 
let ignoreTemporaryState = false; 

// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            'controls': 1, // Keep YouTube's native controls
            'disablekb': 0, 
            'rel': 0,
            'showinfo': 0,
            'modestbranding': 1,
            'autoplay': 0,
            'origin': window.location.origin
        },
        events: {
            'onReady': onPlayerReady, 
            'onStateChange': onPlayerStateChange
        }
    });
}

function onPlayerReady(event) {
    if (player && player.setVolume) {
        player.setVolume(70);
    }
    
    // Broadcast loop for sync
    setInterval(broadcastTimeIfPlaying, 1000); 
    loadInitialData();
}

function broadcastTimeIfPlaying() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        // Auto play next
        if (state === YT.PlayerState.PLAYING && duration - currentTime < 1 && duration > 0) {
            playNextSong();
            return; 
        }

        // Sync Broadcast
        if (state === YT.PlayerState.PLAYING && lastBroadcaster === myName) {
            broadcastState('play', currentTime, currentVideoId, false);
        }
    }
}

function onPlayerStateChange(event) {
    const playPauseBtn = document.getElementById('play-pause-btn');
    
    if (event.data === YT.PlayerState.PLAYING) {
        playPauseBtn.innerHTML = '<i class="fa-solid fa-pause"></i>';
        isManualAction = false; 
        ignoreTemporaryState = false; 
    } else {
        playPauseBtn.innerHTML = '<i class="fa-solid fa-play"></i>';
        
        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
            if (!isPartnerPlaying && !isManualAction && !ignoreTemporaryState && lastBroadcaster === myName) {
                broadcastState('pause', player.getCurrentTime(), currentVideoId, true); 
            }
        } 
        
        if (event.data === YT.PlayerState.ENDED) {
            if (!isPartnerPlaying) {
                broadcastState('pause', player.getCurrentTime(), currentVideoId, false);
            }
            playNextSong();
        }
    }
    
    isManualAction = false;
    isPartnerPlaying = false;
    if (ignoreTemporaryState) {
        setTimeout(() => { ignoreTemporaryState = false; }, 500);
    }
    updateSyncStatus();
}

function togglePlayPause() {
    if (!player || !player.getPlayerState) return;
    const state = player.getPlayerState();
    
    if (state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING) {
        player.pauseVideo();
        document.getElementById('syncOverlay').classList.remove('active'); 
        broadcastState('pause', player.getCurrentTime(), currentVideoId, false); 
    } else {
        if (!currentVideoId && currentQueue.length > 0) {
            loadAndPlayVideo(currentQueue[0].videoId, currentQueue[0].title);
        } else if (currentVideoId) {
            player.playVideo();
            document.getElementById('syncOverlay').classList.remove('active');
            broadcastState('play', player.getCurrentTime(), currentVideoId, false);
        }
    }
    isManualAction = true;
}

function loadAndPlayVideo(videoId, title) {
    if (player && videoId) {
        isManualAction = false;
        ignoreTemporaryState = true; 
        
        player.loadVideoById(videoId);
        currentVideoId = videoId;
        document.getElementById('current-song-title').textContent = title;
        
        setTimeout(() => {
            if(player.getPlayerState() === YT.PlayerState.PLAYING || player.getPlayerState() === YT.PlayerState.BUFFERING) {
                 broadcastState('play', player.getCurrentTime(), videoId, false); 
            }
        }, 300);
        renderQueue(currentQueue, currentVideoId);
    }
}

// ------------------------------------------------------------------------------------------------------
// --- QUEUE & DRAG DROP ---
// ------------------------------------------------------------------------------------------------------

function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    const nextIndex = (currentIndex + 1) % currentQueue.length; 
    if (currentQueue.length > 0) {
        const nextSong = currentQueue[nextIndex];
        loadAndPlayVideo(nextSong.videoId, nextSong.title);
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) prevIndex = currentQueue.length - 1;
    
    if (currentQueue.length > 0) {
        const prevSong = currentQueue[prevIndex];
        loadAndPlayVideo(prevSong.videoId, prevSong.title);
    }
}

function addToQueue(videoId, title, uploader, thumbnail, event) {
    if (event) event.stopPropagation();
    const newSong = { videoId, title, uploader, thumbnail, order: Date.now() + Math.random() };
    const newKey = queueRef.push().key; 
    
    queueRef.child(newKey).set(newSong).then(() => { 
        switchTab('queue'); 
        if (!currentVideoId && currentQueue.length === 0) {
            loadAndPlayVideo(videoId, title);
        }
    });
}

function addBatchToQueue(songs) {
    if (!songs || songs.length === 0) return;
    const updates = {};
    songs.forEach((song, index) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...song, order: Date.now() + index * 1000 }; 
    });
    queueRef.update(updates).then(() => {
        switchTab('queue');
        if (!currentVideoId && currentQueue.length === 0 && songs.length > 0) {
            setTimeout(() => {
                if (songs[0]) { loadAndPlayVideo(songs[0].videoId, songs[0].title); }
            }, 500);
        }
    });
}

function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    const songToRemove = currentQueue.find(song => song.key === key);
    if (songToRemove) {
        queueRef.child(key).remove().then(() => {
            if (songToRemove.videoId === currentVideoId) { playNextSong(); }
        });
    }
}

function updateQueueOrder(newOrder) {
    const updates = {};
    newOrder.forEach((song, index) => {
        updates[`${song.key}/order`] = index;
    });
    queueRef.update(updates).catch(error => console.error("Error updating queue order:", error));
}

// UI RENDERING
function switchTab(tabName) {
    // Handle mobile chat special case
    if(tabName === 'chat-mobile') {
        // Toggle visibility of queue vs chat panel on mobile
        // For simplicity in this structure, we'll just focus the chat input if on desktop
        // or scroll to chat on mobile
        document.getElementById('chat-panel').scrollIntoView({behavior: "smooth"});
        return;
    }
    
    // Toggle Search Input
    const searchContainer = document.getElementById('search-container');
    if (tabName === 'results') {
        searchContainer.style.display = 'flex';
    } else {
        searchContainer.style.display = 'none';
    }

    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(list => list.classList.remove('active'));
    
    // Safety check if elements exist
    const targetTab = document.getElementById(`tab-${tabName}`);
    const targetList = document.getElementById(`${tabName}-list`);
    
    if (targetTab) targetTab.classList.add('active');
    if (targetList) targetList.classList.add('active');
}

function renderQueue(queueArray, currentVideoId) {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    queueArray.sort((a, b) => (a.order || 0) - (b.order || 0));
    currentQueue = queueArray;
    
    if (queueArray.length === 0) {
        queueList.innerHTML = '<div class="empty-state"><i class="fa-solid fa-music"></i><p>Queue is empty.<br>Add songs for her!</p></div>';
        document.getElementById('queue-count').textContent = 0;
        return;
    }
    
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.setAttribute('draggable', 'true'); 
        item.setAttribute('data-key', song.key); 
        item.onclick = (e) => {
            // Only play if not clicking controls
            if(!e.target.closest('.del-btn') && !e.target.closest('.drag-handle')) {
                loadAndPlayVideo(song.videoId, song.title);
            }
        };
        
        item.innerHTML = `
            <div class="drag-handle"><i class="fa-solid fa-grip-lines"></i></div>
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>${song.uploader}</p>
            </div>
            <button class="del-btn" title="Remove" onclick="removeFromQueue('${song.key}', event)">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;
        queueList.appendChild(item);
    });
    
    document.getElementById('queue-count').textContent = queueArray.length;
    addDragDropListeners(queueList, queueArray); 
}

function renderSearchResults(resultsArray) {
    const resultsList = document.getElementById('results-list');
    resultsList.innerHTML = '';
    
    if (resultsArray.length === 0) {
        resultsList.innerHTML = '<div class="empty-state">No results found.</div>';
        return;
    }
    
    resultsArray.forEach(song => {
        const item = document.createElement('div');
        item.className = 'song-item';
        const safeThumbnail = encodeURIComponent(song.thumbnail);
        const safeTitle = song.title.replace(/'/g, "\\'");
        const safeUploader = song.uploader.replace(/'/g, "\\'");
        
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>${song.uploader}</p>
            </div>
            <button class="add-btn" onclick="addToQueue('${song.videoId}', '${safeTitle}', '${safeUploader}', decodeURIComponent('${safeThumbnail}'), event)">
                <i class="fa-solid fa-plus"></i>
            </button>
        `;
        resultsList.appendChild(item);
    });
}

function addDragDropListeners(listElement, originalQueue) {
    let draggingItem = null;
    listElement.querySelectorAll('.song-item').forEach(item => {
        item.addEventListener('dragstart', (e) => {
            draggingItem = item;
            item.style.opacity = '0.5';
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.getAttribute('data-key'));
        });
        
        item.addEventListener('dragover', (e) => {
            e.preventDefault(); 
            if (item !== draggingItem && draggingItem) {
                const rect = item.getBoundingClientRect();
                const offsetY = e.clientY - rect.top;
                if (offsetY < rect.height / 2) {
                    listElement.insertBefore(draggingItem, item);
                } else {
                    listElement.insertBefore(draggingItem, item.nextSibling);
                }
            }
        });

        item.addEventListener('dragend', () => {
            if (draggingItem) draggingItem.style.opacity = '1';
            draggingItem = null;
            
            const newOrderKeys = Array.from(listElement.querySelectorAll('.song-item'))
                                     .map(el => el.getAttribute('data-key'));
            const newOrder = newOrderKeys.map(key => originalQueue.find(song => song.key === key));
            updateQueueOrder(newOrder); 
        });
    });
}

// ------------------------------------------------------------------------------------------------------
// --- SEARCH & API ---
// ------------------------------------------------------------------------------------------------------

async function searchYouTube(query, maxResults = 10) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
    try {
        const response = await fetch(url);
        const data = await response.json();
        if (data.error) return [];
        return data.items.map(item => ({
            videoId: item.id.videoId,
            title: item.snippet.title,
            uploader: item.snippet.channelTitle,
            thumbnail: item.snippet.thumbnails.default.url 
        }));
    } catch (error) {
        console.error("Fetch Error:", error);
        return [];
    }
}

async function handleSearchAndLinks() {
    const inputElement = document.getElementById('searchInput');
    const query = inputElement.value.trim();
    if (!query) return;

    // (Kept simplified: Logic for playlist/Spotify import can remain if needed, 
    // but ensuring the visual search works first)
    
    switchTab('results');
    document.getElementById('results-list').innerHTML = '<div class="empty-state">Searching...</div>';
    currentSearchResults = await searchYouTube(query, 10);
    renderSearchResults(currentSearchResults);
    inputElement.value = '';
}

// ------------------------------------------------------------------------------------------------------
// --- SYNC & CHAT ---
// ------------------------------------------------------------------------------------------------------

function loadInitialData() {
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const queueData = snapshot.val();
        let fetchedQueue = [];
        if (queueData) {
            Object.keys(queueData).forEach(key => fetchedQueue.push({ ...queueData[key], key: key }));
        }
        fetchedQueue.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = fetchedQueue;
        renderQueue(currentQueue, currentVideoId);
    });

    partnerSyncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        if (syncState) {
            lastBroadcaster = syncState.lastUpdater; 
            if (syncState.lastUpdater !== myName) {
                applyRemoteCommand(syncState);
            }
        } else {
             document.getElementById('syncOverlay').classList.remove('active');
        }
        updateSyncStatus();
    });

    chatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
    partnerChatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
}

function broadcastState(action, time, videoId = currentVideoId, isAdStall = false) {
    if (!videoId) return;
    mySyncRef.set({
        action: action, time: time, videoId: videoId,
        lastUpdater: myName, isAdStall: isAdStall, timestamp: Date.now()
    });
}

function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; 
    
    if (!partnerIsPlaying && state.isAdStall) {
           document.getElementById('syncOverlay').classList.add('active');
           if (player.getPlayerState() !== YT.PlayerState.PAUSED) player.pauseVideo();
           updateSyncStatus();
           return;
    }
    
    document.getElementById('syncOverlay').classList.remove('active');
    
    if (state.videoId !== currentVideoId) {
        player.loadVideoById(state.videoId, state.time);
        currentVideoId = state.videoId;
        const song = currentQueue.find(s => s.videoId === state.videoId);
        document.getElementById('current-song-title').textContent = song ? song.title : 'Partner chose a song...';
        renderQueue(currentQueue, currentVideoId);
    } else {
        const localTime = player.getCurrentTime ? player.getCurrentTime() : 0;
        if (Math.abs(localTime - state.time) > 2.5) { 
            player.seekTo(state.time, true);
        }
    }
    
    if (partnerIsPlaying) {
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) player.playVideo();
    } else {
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) player.pauseVideo();
    }
    updateSyncStatus();
}

function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    const overlayIsActive = document.getElementById('syncOverlay').classList.contains('active');
    if (overlayIsActive) {
        document.getElementById('overlayText').textContent = `Waiting for ${lastBroadcaster}...`;
        msgEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> WAITING FOR PARTNER`;
        msgEl.style.color = 'var(--accent)';
    } else if (player && player.getPlayerState() === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-heart pulse-heart"></i> LISTENING TOGETHER`;
        msgEl.style.color = 'var(--primary)';
    } else {
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> PAUSED`;
        msgEl.style.color = 'var(--text-dim)';
    }
}

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    myChatRef.push({ user: myName, text: text, timestamp: Date.now() })
        .then(() => { input.value = ''; });
}

function displayChatMessage(user, text, timestamp) {
    const chatMessages = document.getElementById('chat-messages');
    const isMe = user === myName;
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isMe ? 'me' : 'partner'}`;
    const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    
    msgDiv.innerHTML = `${safeText} <small>${time}</small>`;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// EVENTS
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.getElementById('prev-btn').addEventListener('click', playPreviousSong);
    document.getElementById('next-btn').addEventListener('click', playNextSong);

    document.getElementById('search-btn').addEventListener('click', handleSearchAndLinks);
    document.getElementById('searchInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') handleSearchAndLinks();
    });

    document.getElementById('chatSendBtn').addEventListener('click', sendChatMessage);
    document.getElementById('chatInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') sendChatMessage();
    });
    
    document.getElementById('forceSyncBtn').addEventListener('click', () => {
        document.getElementById('syncOverlay').classList.remove('active');
        if (player) player.playVideo();
    });
});
