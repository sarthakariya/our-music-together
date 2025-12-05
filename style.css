// ... (Keep existing CONFIGURATION and DOM setup) ...

// Variables
let player;
// ... (keep queue, currentIndex, etc.)
let myName = "Guest"; 

// ... (onYouTubeIframeAPIReady remains the same) ...

function identifyUser() {
    let name = prompt("Welcome! Please enter your name for chat (Sarthak or Reechita):");
    if (name) {
        name = name.trim();
        if (name.toLowerCase().includes('sarthak')) {
            myName = "Sarthak";
        } else if (name.toLowerCase().includes('reechita')) {
            myName = "Reechita";
        } else {
            myName = name; 
        }
        // Ensure the chat section acknowledges the correct name
        dom.chatBox.innerHTML += `<div class="chat-message system">You are logged in as **${myName}**.</div>`;
    }
}

function onPlayerReady() {
    identifyUser(); 
    initSync();
    initChatListener();
    
    // UI Loop
    setInterval(updateUI, 500);
    // Master Status Check Loop
    setInterval(checkPlaybackStatus, 1000);
}

// ... (onPlayerStateChange remains the same) ...

// ================= V5: STRICT SYNCHRONIZATION PROTOCOL =================

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

            // CRITICAL AD LOCK VERIFICATION:
            if (data.adDetected) {
                // If ad is detected anywhere, everyone pauses and sees the wait screen
                if(player.getPlayerState() !== 2) player.pauseVideo();
                // THIS ENSURES THE OVERLAY IS ACTIVE FOR EVERYONE
                if(!dom.overlay.classList.contains('active')) dom.overlay.classList.add('active'); 
            } else {
                
                const serverStatus = data.status;
                const serverTime = data.time || 0;
                const skipCmd = data.skipCmd || 0;

                dom.overlay.classList.remove('active');
                
                // ... (Rest of status and skip sync logic remains the same) ...
            }
        }
    });
}

// ... (Rest of checkPlaybackStatus, togglePlay, forceSyncResume, 
// fetchPlaylist, searchYouTube, and UI Helpers remain the same, 
// except for the corrected name handling in renderMessage) ...

window.sendMessage = function() {
    const text = dom.chatIn.value.trim();
    if (text) {
        chatRef.push({
            user: myName, // Uses the correctly identified name
            message: text,
            timestamp: firebase.database.ServerValue.TIMESTAMP
        });
        dom.chatIn.value = '';
    }
}

function renderMessage(user, message, timestamp) {
    const div = document.createElement('div');
    const senderClass = (user === myName) ? 'me' : 'partner';
    
    // CORRECTED: Check for specific user names
    const partnerName = (myName === "Sarthak") ? "Reechita" : "Sarthak";
    const userIsKnown = (user === "Sarthak" || user === "Reechita");

    div.className = `chat-message ${senderClass}`;

    const date = new Date(timestamp);
    const timeStr = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    div.innerHTML = `
        <p><strong>${user}:</strong> ${message}</p>
        <small>${timeStr}</small>
    `;
    dom.chatBox.appendChild(div);
    dom.chatBox.scrollTop = dom.chatBox.scrollHeight;
}
