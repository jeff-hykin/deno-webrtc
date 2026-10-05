// Two connections in one process, talking over a data channel.
import { RTCPeerConnection } from "../mod.js"

const a = new RTCPeerConnection()
const b = new RTCPeerConnection()
a.onicecandidate = ({ candidate }) => candidate && b.addIceCandidate(candidate)
b.onicecandidate = ({ candidate }) => candidate && a.addIceCandidate(candidate)

const channel = a.createDataChannel("chat")
const received = new Promise((resolve) => {
    b.ondatachannel = ({ channel }) => {
        channel.onmessage = ({ data }) => resolve(data)
    }
})
channel.onopen = () => channel.send("hello from a")

await a.setLocalDescription()
await b.setRemoteDescription(a.localDescription)
await b.setLocalDescription()
await a.setRemoteDescription(b.localDescription)

console.log("b received:", await received)
a.close()
b.close()
