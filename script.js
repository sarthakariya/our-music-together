// --- CONFIGURATION ---
// Your Firebase Configuration (Provided by Sarthak)
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
// Your YouTube API Key (Provided by Sarthak)
const YOUTUBE_API_KEY = "AIzaSyDInaN1IfgD6VqMLLY7Wh1DbyKd6kcDi68";

// Initialize Firebase
if (typeof firebase !== 'undefined' && !firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const db = firebase.database();

// --- USER IDENTIFICATION (Ensuring a Fixed Name is Used for DB Path) ---
let myName = "Sarthak"; 
const storedName = localStorage.getItem('deepSpaceUserName');
if (storedName) {
    myName = storedName;
} else {
    // Note: The prompt is crucial here. If Reechita registers her account first, 
    // she must enter her correct name here.
    const enteredName = prompt("Welcome to Deep Space Sync! Please enter your name (Sarthak or Partner's Name):");
    if (enteredName && enteredName.trim() !== "") {
        myName = enteredName.trim();
        localStorage.setItem('deepSpaceUserName', myName);
    }
}

// CRITICAL FIX: The name used for the Database path MUST be normalized and fixed.
// We are assuming the fixed partners are Sarthak and Reechita.
const fixedDBName = (myName.toLowerCase() === "sarthak") ? "Sarthak" : "Reechita"; 
const fixedPartnerName = (fixedDBName === "Sarthak") ? "Reechita" : "Sarthak";

// --- NEW/FIXED DATABASE REFERENCES ---
// 1. Shared Global Queue (CRITICAL FIX for shared playlist control)
const queueRef = db.ref('queue');

// 2. User-Specific References (Correct for separate sync control and chat)
const myRootRef = db.ref(`users/${fixedDBName}`);
const mySyncRef = myRootRef.child('sync');
const myChatRef = myRootRef.child('chat');

const partnerRootRef = db.ref(`users/${fixedPartnerName}`);
const partnerSyncRef = partnerRootRef.child('sync');
const partnerChatRef = partnerRootRef.child('chat');

// Restore the original global sync/chat references to point to the user's OWN ref
const syncRef = mySyncRef; 
const chatRef = myChatRef; 

const partnerName = (myName === "Sarthak" || myName === "sarthak") ? "Partner" : "Sarthak";


// --- GLOBAL STATE ---
let player; 
let currentQueue = [];
let currentSearchResults = [];
let currentVideoId = null;
let isPartnerPlaying = false; 
let lastBroadcaster = "System";
let isManualAction = false; 
let ignoreTemporaryState = false; 
let lastSyncState = null; 


// ------------------------------------------------------------------------------------------------------
// --- YOUTUBE PLAYER FUNCTIONS (API Required) ---
// ------------------------------------------------------------------------------------------------------

function onYouTubeIframeAPIReady() {
    player = new YT.Player('player', {
        height: '100%',
        width: '100%',
        videoId: '', 
        playerVars: {
            'controls': 1,           
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
    
    // Time broadcast interval (for sync)
    setInterval(broadcastTimeIfPlaying, 1000); 

    loadInitialData(); 
}

function broadcastTimeIfPlaying() {
    if (player && player.getPlayerState && currentVideoId) {
        const state = player.getPlayerState();
        const currentTime = player.getCurrentTime();
        const duration = player.getDuration();
        
        // Auto play next song if ended 
        if (state === YT.PlayerState.PLAYING && duration - currentTime < 1 && duration > 0) {
            playNextSong();
            return; 
        }

        // Only broadcast state if we are the last known broadcaster and currently playing
        if (state === YT.PlayerState.PLAYING && lastBroadcaster === myName) {
            broadcastState('play', currentTime, currentVideoId, false);
        }
    }
}

function onPlayerStateChange(event) {
    const playPauseBtn = document.getElementById('play-pause-btn');
    const playIcon = '<i class="fa-solid fa-play"></i>';
    const pauseIcon = '<i class="fa-solid fa-pause"></i>';
    
    if (event.data === YT.PlayerState.PLAYING) {
        playPauseBtn.innerHTML = pauseIcon;
        isManualAction = false; 
        ignoreTemporaryState = false; 
        
    } else {
        playPauseBtn.innerHTML = playIcon;

        // CRITICAL AD/BUFFER LOGIC (Broadcast Ad Stall if paused unexpectedly)
        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.BUFFERING) {
            
            if (!isPartnerPlaying && !isManualAction && !ignoreTemporaryState && lastBroadcaster === myName) {
                // Local player paused on its own (ad/buffer) - Broadcast Ad Stall
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
        
        const songToPlay = currentQueue.find(song => song.videoId === videoId);
        
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
// --- QUEUE MANAGEMENT (FIXED & REARRANGE) ---
// ------------------------------------------------------------------------------------------------------

function playNextSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    const nextIndex = (currentIndex + 1) % currentQueue.length; 
    
    if (currentQueue.length > 0) {
        const nextSong = currentQueue[nextIndex];
        loadAndPlayVideo(nextSong.videoId, nextSong.title);
    } else {
        currentVideoId = null;
        if (player && player.stopVideo) player.stopVideo();
        document.getElementById('current-song-title').textContent = "Queue Ended";
    }
}

function playPreviousSong() {
    const currentIndex = currentQueue.findIndex(song => song.videoId === currentVideoId);
    let prevIndex = currentIndex - 1;
    if (prevIndex < 0) { prevIndex = currentQueue.length - 1; } 
    
    if (currentQueue.length > 0) {
        const prevSong = currentQueue[prevIndex];
        loadAndPlayVideo(prevSong.videoId, prevSong.title);
    }
}

function addToQueue(videoId, title, uploader, thumbnail, event) {
    if (event) event.stopPropagation();
    
    const newSong = { 
        videoId, 
        title, 
        uploader, 
        thumbnail, 
        order: Date.now() + Math.random() 
    };
    const newKey = queueRef.push().key; 
    
    queueRef.child(newKey).set(newSong)
        .then(() => { 
            switchTab('queue'); 
            
            if (!currentVideoId && currentQueue.length === 0) {
                loadAndPlayVideo(videoId, title);
            }
        })
        .catch(error => { console.error("Error adding song to queue:", error); });
}

function addBatchToQueue(songs) {
    if (!songs || songs.length === 0) return;
    const updates = {};
    songs.forEach((song, index) => {
        const newKey = queueRef.push().key;
        updates[newKey] = { ...song, order: Date.now() + index * 1000 }; 
    });
    
    queueRef.update(updates)
        .then(() => {
            switchTab('queue');
            if (!currentVideoId && currentQueue.length === 0 && songs.length > 0) {
                setTimeout(() => {
                    const firstSong = songs[0];
                    if (firstSong) { loadAndPlayVideo(firstSong.videoId, firstSong.title); }
                }, 500);
            }
        })
        .catch(error => { console.error("Error adding batch to queue:", error); });
}

function removeFromQueue(key, event) {
    if (event) event.stopPropagation();
    
    const songToRemove = currentQueue.find(song => song.key === key);
    
    if (songToRemove) {
        queueRef.child(key).remove()
            .then(() => {
                if (songToRemove.videoId === currentVideoId) { 
                    playNextSong(); 
                }
            })
            .catch(error => { console.error("Error removing song:", error); });
    }
}

function updateQueueOrder(newOrder) {
    const updates = {};
    newOrder.forEach((song, index) => {
        updates[`${song.key}/order`] = index;
    });

    queueRef.update(updates)
        .catch(error => console.error("Error updating queue order:", error));
}


// ------------------------------------------------------------------------------------------------------
// --- RENDERING VIEWS (DRAG & DROP IMPLEMENTATION) ---
// ------------------------------------------------------------------------------------------------------

function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(tab => tab.classList.remove('active'));
    document.querySelectorAll('.list-view').forEach(list => list.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');
    document.getElementById(`${tabName}-list`).classList.add('active');
}

function renderQueue(queueArray, currentVideoId) {
    const queueList = document.getElementById('queue-list');
    queueList.innerHTML = '';
    
    queueArray.sort((a, b) => (a.order || 0) - (b.order || 0));
    currentQueue = queueArray; 

    if (queueArray.length === 0) {
        queueList.innerHTML = '<p class="empty-state">Queue is empty. Find a song to get the party started!</p>';
        document.getElementById('queue-count').textContent = 0;
        return;
    }
    
    queueArray.forEach((song, index) => {
        const item = document.createElement('div');
        item.className = `song-item ${song.videoId === currentVideoId ? 'playing' : ''}`;
        item.setAttribute('draggable', 'true'); 
        item.setAttribute('data-key', song.key); 
        item.setAttribute('onclick', `loadAndPlayVideo('${song.videoId}', '${song.title.replace(/'/g, "\\'")}')`);
        
        item.innerHTML = `
            <i class="fa-solid fa-grip-vertical drag-handle"></i>
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${index + 1}. ${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <div class="item-controls">
                <button class="del-btn" title="Remove from Queue" onclick="removeFromQueue('${song.key}', event)">
                    <i class="fa-solid fa-trash-can"></i>
                </button>
            </div>
        `;
        queueList.appendChild(item);
    });
    
    document.getElementById('queue-count').textContent = queueArray.length;
    
    addDragDropListeners(queueList, queueArray); 

    const playingItem = queueList.querySelector('.song-item.playing');
    if (playingItem) {
        playingItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function renderSearchResults(resultsArray) {
    const resultsList = document.getElementById('results-list');
    resultsList.innerHTML = ''; 
    if (resultsArray.length === 0) {
        resultsList.innerHTML = '<p class="empty-state">No search results found. Try a different query!</p>';
        return;
    }
    resultsArray.forEach(song => {
        const item = document.createElement('div');
        item.className = 'song-item';
        const safeThumbnail = encodeURIComponent(song.thumbnail);
        
        item.innerHTML = `
            <img src="${song.thumbnail}" class="thumb" alt="Thumbnail">
            <div class="meta">
                <h4>${song.title}</h4>
                <p>Uploader: ${song.uploader}</p>
            </div>
            <button class="add-btn" title="Add to Queue" onclick="addToQueue('${song.videoId}', '${song.title.replace(/'/g, "\\'")}', '${song.uploader.replace(/'/g, "\\'")}', decodeURIComponent('${safeThumbnail}'), event)">
                <i class="fa-solid fa-plus"></i>
            </button>
        `;
        resultsList.appendChild(item);
    });
}


// --- DRAG AND DROP LOGIC ---
function addDragDropListeners(listElement, originalQueue) {
    let draggingItem = null;

    listElement.querySelectorAll('.song-item').forEach(item => {
        
        // DRAG START
        item.addEventListener('dragstart', (e) => {
            if (e.target.closest('.del-btn')) {
                e.preventDefault();
                return;
            }
            draggingItem = item;
            item.classList.add('dragging');
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', item.getAttribute('data-key'));
        });

        // DRAG OVER
        item.addEventListener('dragover', (e) => {
            e.preventDefault(); 
            e.dataTransfer.dropEffect = 'move';
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

        // DRAG END
        item.addEventListener('dragend', () => {
            if (draggingItem) {
                draggingItem.classList.remove('dragging');
            }
            draggingItem = null;
            
            const newOrderKeys = Array.from(listElement.querySelectorAll('.song-item'))
                                         .map(el => el.getAttribute('data-key'));
            
            const newOrder = newOrderKeys.map(key => originalQueue.find(song => song.key === key));
            
            updateQueueOrder(newOrder); 
        });
        
        item.querySelector('.item-controls').addEventListener('click', (e) => {
            e.stopPropagation();
        });
        
        item.addEventListener('click', (e) => {
            if (e.defaultPrevented) return;
            const key = item.getAttribute('data-key');
            const song = originalQueue.find(s => s.key === key);
            if (song) {
                loadAndPlayVideo(song.videoId, song.title);
            }
        });
    });
}
// ------------------------------------------------------------------------------------------------------


// ------------------------------------------------------------------------------------------------------
// --- SEARCH & LINK HANDLERS ---
// ------------------------------------------------------------------------------------------------------

async function searchYouTube(query, maxResults = 10, type = 'video') {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=${type}&maxResults=${maxResults}&key=${YOUTUBE_API_KEY}`;
    
    try {
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            console.error("YouTube API Error:", data.error.message);
            return [];
        }

        const results = data.items
            .filter(item => item.id.kind === 'youtube#video')
            .map(item => ({
                videoId: item.id.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url 
            }));
        
        return results;

    } catch (error) {
        console.error("YouTube Search Fetch Error:", error);
        return [];
    }
}

function extractPlaylistId(url) {
    const regex = /(?:list=)([a-zA-Z0-9_-]+)/;
    const match = url.match(regex);
    if (match) {
        return match[1];
    }
    return null;
}

async function fetchPlaylist(playlistId, pageToken = null, allSongs = []) {
    switchTab('results');
    const statusDiv = document.getElementById('results-list');
    
    const url = `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&maxResults=50&playlistId=${playlistId}&key=${YOUTUBE_API_KEY}${pageToken ? `&pageToken=${pageToken}` : ''}`;
    
    try {
        statusDiv.innerHTML = `<p class="empty-state">Fetching playlist (Total songs: ${allSongs.length})... Please wait.</p>`;
        
        const response = await fetch(url);
        const data = await response.json();

        if (data.error) {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Error fetching playlist: ${data.error.message}. Check the link or your API key.</p>`;
            return;
        }

        const newSongs = data.items
            .filter(item => item.snippet && item.snippet.resourceId && item.snippet.resourceId.kind === 'youtube#video')
            .map(item => ({
                videoId: item.snippet.resourceId.videoId,
                title: item.snippet.title,
                uploader: item.snippet.channelTitle,
                thumbnail: item.snippet.thumbnails.default.url
            }));
        
        allSongs = allSongs.concat(newSongs);

        if (data.nextPageToken) {
            return await fetchPlaylist(playlistId, data.nextPageToken, allSongs);
        } else {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">✅ Found ${allSongs.length} songs from the playlist. Adding to queue...</p>`;
            addBatchToQueue(allSongs);
            setTimeout(() => switchTab('queue'), 3000); 
        }

    } catch (error) {
        console.error("Playlist Fetch Error:", error);
        statusDiv.innerHTML = '<p class="empty-state" style="color: var(--text-error);">Failed to fetch playlist items. Network error or invalid ID.</p>';
    }
}

function extractSpotifyId(url) {
    const match = url.match(/(?:playlist|album|track)\/([a-zA-Z0-9]+)/);
    if (match) {
        return url; 
    }
    return null;
}

async function fetchSpotifyData(link) {
    const statusDiv = document.getElementById('results-list');
    statusDiv.innerHTML = '<p class="empty-state">Attempting to fetch Spotify data and find YouTube matches (This may take a moment)...</p>';

    const proxyUrl = `https://spotify-proxy.vercel.app/api/data?url=${encodeURIComponent(link)}`;

    try {
        const response = await fetch(proxyUrl);
        const data = await response.json();

        if (!data || data.error || !data.tracks || data.tracks.length === 0) {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Failed to fetch Spotify data or playlist is empty. (Error: ${data.error || 'Unknown'})</p>`;
            return;
        }
        
        const tracksToSearch = data.tracks.slice(0, 50); 
        const foundSongs = [];
        
        statusDiv.innerHTML = `<p class="empty-state">Found ${tracksToSearch.length} tracks. Searching YouTube for matches...</p>`;

        for (const track of tracksToSearch) {
            const query = `${track.artist} - ${track.title}`;
            const results = await searchYouTube(query, 1); 
            
            if (results.length > 0) {
                foundSongs.push(results[0]);
            }
            statusDiv.innerHTML = `<p class="empty-state">Searching YouTube... Found ${foundSongs.length} matches out of ${tracksToSearch.length} tracks.</p>`;
        }
        
        if (foundSongs.length > 0) {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--primary);">✅ Added ${foundSongs.length} songs from Spotify link to the queue!</p>`;
            addBatchToQueue(foundSongs);
        } else {
            statusDiv.innerHTML = `<p class="empty-state" style="color: var(--text-error);">Could not find matching YouTube videos for the Spotify tracks.</p>`;
        }
        setTimeout(() => switchTab('queue'), 3000); 
        
    } catch (error) {
        console.error("Spotify Proxy Error:", error);
        statusDiv.innerHTML = '<p class="empty-state" style="color: var(--text-error);">Connection error while fetching Spotify data. The proxy may be down.</p>';
    }
}

async function handleSearchAndLinks() {
    const inputElement = document.getElementById('searchInput');
    const query = inputElement.value.trim();
    if (!query) return;

    const playlistId = extractPlaylistId(query);
    if (playlistId) {
        await fetchPlaylist(playlistId);
        inputElement.value = ''; 
        return;
    }
    
    const spotifyLink = extractSpotifyId(query);
    if (spotifyLink) {
        await fetchSpotifyData(spotifyLink); 
        inputElement.value = '';
        return;
    }

    switchTab('results');
    document.getElementById('results-list').innerHTML = '<p class="empty-state">Searching...</p>';

    currentSearchResults = await searchYouTube(query, 10);
    
    if (currentSearchResults.length === 0) {
        document.getElementById('results-list').innerHTML = '<p class="empty-state" style="color: var(--text-error);">Search failed! Check your API key, network, or try a simpler query.</p>';
    } else {
        renderSearchResults(currentSearchResults);
    }
    
    inputElement.value = '';
}


// ------------------------------------------------------------------------------------------------------
// --- FIREBASE SYNC (REALTIME DATABASE) ---
// ------------------------------------------------------------------------------------------------------

function loadInitialData() {
    // 1. Queue Listener (Listens to the single global 'queue' node)
    queueRef.orderByChild('order').on('value', (snapshot) => {
        const queueData = snapshot.val();
        let fetchedQueue = [];
        if (queueData) {
            Object.keys(queueData).forEach(key => {
                fetchedQueue.push({ ...queueData[key], key: key });
            });
        }
        
        fetchedQueue.sort((a, b) => (a.order || 0) - (b.order || 0));
        currentQueue = fetchedQueue;
        renderQueue(currentQueue, currentVideoId);
    });

    // 2. Sync Command Listener (Listens to the PARTNER's sync node for commands)
    partnerSyncRef.on('value', (snapshot) => {
        const syncState = snapshot.val();
        lastSyncState = syncState; 

        if (syncState) {
            lastBroadcaster = syncState.lastUpdater; 

            // Only apply command if the update is from the partner
            if (syncState.lastUpdater !== myName) {
                applyRemoteCommand(syncState);
            }
        } else {
             document.getElementById('syncOverlay').classList.remove('active');
        }
        
        updateSyncStatus();
    });

    // 3. Chat Listener (Listens to MY chatRef for my messages)
    chatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
    
    // NEW: Listen to PARTNER's chatRef for their messages
    partnerChatRef.limitToLast(20).on('child_added', (snapshot) => {
        const message = snapshot.val();
        displayChatMessage(message.user, message.text, message.timestamp);
    });
}

function broadcastState(action, time, videoId = currentVideoId, isAdStall = false) {
    if (!videoId) return;

    mySyncRef.set({
        action: action, 
        time: time,
        videoId: videoId,
        lastUpdater: myName, 
        isAdStall: isAdStall, 
        timestamp: Date.now()
    });
}

function applyRemoteCommand(state) {
    if (!player || !state || state.videoId === undefined) return;
    
    const partnerIsPlaying = state.action === 'play';
    isPartnerPlaying = true; 
    
    const localTime = player.getCurrentTime ? player.getCurrentTime() : 0; 
    
    // CRITICAL AD STALL LOGIC: If partner is reporting a stall, pause locally and wait.
    if (!partnerIsPlaying && state.isAdStall) {
           document.getElementById('syncOverlay').classList.add('active');
           if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
             player.pauseVideo();
           }
           updateSyncStatus();
           return; 
    }
    
    // Command is not an ad stall, so remove the overlay if it was showing
    document.getElementById('syncOverlay').classList.remove('active');
    
    if (state.videoId !== currentVideoId) {
        // SCENARIO 1: Partner is playing a different song. Load it and seek.
        const song = currentQueue.find(s => s.videoId === state.videoId);
        const title = song ? song.title : 'External Sync';

        player.loadVideoById(state.videoId, state.time);
        currentVideoId = state.videoId;
        document.getElementById('current-song-title').textContent = title;
        renderQueue(currentQueue, currentVideoId);
        
    } else {
        // SCENARIO 2: Same song, check for time drift (YOUR IDEA IMPLEMENTED HERE)
        const timeDiff = Math.abs(localTime - state.time);
        
        // Threshold set to 2.5 seconds for robust automatic resync
        if (timeDiff > 2.5) { 
            console.log(`Resyncing: Local time ${localTime.toFixed(1)}s, Partner time ${state.time.toFixed(1)}s. Diff: ${timeDiff.toFixed(1)}s`);
            player.seekTo(state.time, true);
        }
    }
    
    // Play/Pause Command Logic
    if (partnerIsPlaying) {
        if (player.getPlayerState() !== YT.PlayerState.PLAYING) {
            player.playVideo();
        }
    } else {
        if (player.getPlayerState() !== YT.PlayerState.PAUSED) {
            player.pauseVideo();
        }
    }
    updateSyncStatus();
}

function forcePlay() {
    document.getElementById('syncOverlay').classList.remove('active');
    if (currentVideoId) {
        player.playVideo();
        broadcastState('play', player.getCurrentTime(), currentVideoId, false);
    }
}

function updateSyncStatus() {
    const msgEl = document.getElementById('sync-status-msg');
    const overlayIsActive = document.getElementById('syncOverlay').classList.contains('active');
    
    if (overlayIsActive) {
           document.getElementById('overlayTitle').textContent = `⚠️ PAUSED by ${lastBroadcaster}`;
           document.getElementById('overlayText').innerHTML = `Playback paused because **${lastBroadcaster}** is experiencing an **Ad/Buffer stall**. Please wait for them to resume or use **Force Play & Sync** to override.`;
           
           msgEl.innerHTML = `<i class="fa-solid fa-triangle-exclamation pulse"></i> **STALL HALT** (Waiting for ${lastBroadcaster})`;
           msgEl.style.color = 'var(--text-error)';
           
    } else if (player && player.getPlayerState() === YT.PlayerState.PLAYING) {
        msgEl.innerHTML = `<i class="fa-solid fa-satellite-dish"></i> **DEEP SYNC ACTIVE**`;
        msgEl.style.color = 'var(--primary)';
    } else {
        msgEl.innerHTML = `<i class="fa-solid fa-pause"></i> **PAUSED**`;
        msgEl.style.color = 'var(--text-dim)';
    }
}

// ------------------------------------------------------------------------------------------------------
// --- CHAT FUNCTIONS ---
// ------------------------------------------------------------------------------------------------------

function sendChatMessage() {
    const input = document.getElementById('chatInput');
    const text = input.value.trim();
    if (!text) return;

    myChatRef.push({ 
        user: myName,
        text: text,
        timestamp: Date.now()
    }).then(() => {
        input.value = ''; 
    }).catch(error => {
        console.error("Error sending message:", error);
    });
}

function displayChatMessage(user, text, timestamp) {
    const chatMessages = document.getElementById('chat-messages');
    const isMe = user === myName;
    const time = new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    const msgDiv = document.createElement('div');
    msgDiv.className = `chat-message ${isMe ? 'me' : 'partner'}`;
    
    const safeText = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    msgDiv.innerHTML = `
        <strong>${user}:</strong> ${safeText}
        <small>${time}</small>
    `;
    
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}


// ------------------------------------------------------------------------------------------------------
// --- INITIALIZATION: EVENT LISTENERS ---
// ------------------------------------------------------------------------------------------------------

function initializeAppListeners() {
    console.log("Setting up application event listeners (Updated)...");
    
    document.getElementById('play-pause-btn').addEventListener('click', togglePlayPause);
    document.getElementById('prev-btn').addEventListener('click', playPreviousSong);
    document.getElementById('next-btn').addEventListener('click', playNextSong);

    document.getElementById('search-btn').addEventListener('click', handleSearchAndLinks);
    document.getElementById('searchInput').addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            handleSearchAndLinks();
        }
    });
    
    document.getElementById('tab-results').addEventListener('click', () => switchTab('results'));
    document.getElementById('tab-queue').addEventListener('click', () => switchTab('queue'));
    document.getElementById('tab-chat').addEventListener('click', () => switchTab('chat'));

    document.getElementById('sendChatBtn').addEventListener('click', sendChatMessage);
    document.getElementById('chatInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            sendChatMessage();
        }
    });
    
    document.getElementById('forcePlayBtn').addEventListener('click', forcePlay);
}

// Initial Listener Setup
document.addEventListener('DOMContentLoaded', initializeAppListeners);
