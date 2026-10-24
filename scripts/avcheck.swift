// swift scripts/avcheck.swift <file.mp4>: what AVFoundation (Safari's media stack) makes of an MP4:
// playable, codec, size, duration, and a decode of every frame. macOS only.
import AVFoundation
let url = URL(fileURLWithPath: CommandLine.arguments[1])
let asset = AVURLAsset(url: url)
let sem = DispatchSemaphore(value: 0)
Task {
  do {
    let playable = try await asset.load(.isPlayable)
    let tracks = try await asset.loadTracks(withMediaType: .video)
    guard let track = tracks.first else { print("no video track"); exit(1) }
    let fmts = try await track.load(.formatDescriptions)
    let sub = fmts.first.map { CMFormatDescriptionGetMediaSubType($0) } ?? 0
    let fourcc = String(bytes: [UInt8(sub >> 24 & 255), UInt8(sub >> 16 & 255), UInt8(sub >> 8 & 255), UInt8(sub & 255)], encoding: .ascii) ?? "?"
    let size = try await track.load(.naturalSize)
    let fps = try await track.load(.nominalFrameRate)
    let dur = try await asset.load(.duration)
    let reader = try AVAssetReader(asset: asset)
    let out = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange])
    reader.add(out)
    reader.startReading()
    var n = 0
    while let s = out.copyNextSampleBuffer() { if CMSampleBufferGetImageBuffer(s) != nil { n += 1 } }
    print("playable=\(playable) codec=\(fourcc) size=\(Int(size.width))x\(Int(size.height)) duration=\(String(format: "%.3f", dur.seconds))s nominalFps=\(fps) decodedFrames=\(n) reader=\(reader.status == .completed ? "completed" : "failed \(String(describing: reader.error))")")
  } catch { print("error: \(error)") }
  sem.signal()
}
sem.wait()
