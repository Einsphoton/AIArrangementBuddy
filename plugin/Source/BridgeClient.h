/**
 * 极简 HTTP 桥接客户端（JUCE 8，零额外依赖）。
 *
 * 只做三件事：提交生成任务、轮询任务、下载 WAV。
 * 注意：本文件是脚手架，未在本机编译（本机无 cmake/MSVC）；接口按服务端
 * `/api/vst3/*`（见 docs/VST3_PLUGIN.md）实现。
 */
#pragma once

#include <JuceHeader.h>
#include <functional>
#include <vector>

namespace aiab
{
struct GenerateRequest
{
    juce::String type = "generate_audio"; // generate_audio | repaint_audio | generate_stem
    juce::String caption;
    int bpm = 0;                  // 0 = 交给模型
    juce::String keyscale;        // 例如 "D minor"
    double durationSec = 20.0;
    int seed = -1;                // -1 = 随机
    juce::String style;
    juce::String adapterId;
    int priority = 0;             // 0/1/2
    juce::String sourceAssetId;   // repaint / stem 用
    double startSec = 0.0;        // repaint 用
    double endSec = 0.0;
    juce::String arm;             // stem 用
};

struct TaskView
{
    juce::String id;
    juce::String type;
    juce::String status;
    double progress = 0.0;
    bool terminal = false;
    int queuePosition = 0;
    double estimatedWaitSec = 0.0;
    juce::String assetId;
    juce::String error;
};

class BridgeClient
{
public:
    explicit BridgeClient (juce::String baseUrl = "http://127.0.0.1:8787")
        : baseUrl (std::move (baseUrl))
    {
    }

    void setBaseUrl (juce::String url) { baseUrl = std::move (url); }
    juce::String getBaseUrl() const { return baseUrl; }

    /** hello：确认服务端与 Companion 在线；返回在线 worker 数，失败返回 -1 */
    int hello (juce::String& errorOut) const
    {
        auto payload = getJson ("/api/vst3/hello", errorOut);
        if (payload.isVoid())
            return -1;
        return (int) (double) payload.getProperty ("onlineWorkers", 0);
    }

    /** 提交任务：成功返回 taskId，失败返回空串并写 errorOut */
    juce::String submit (const GenerateRequest& req, juce::String& errorOut) const
    {
        juce::DynamicObject::Ptr params = new juce::DynamicObject();
        if (req.caption.isNotEmpty())     params->setProperty ("caption", req.caption);
        if (req.bpm > 0)                  params->setProperty ("bpm", req.bpm);
        if (req.keyscale.isNotEmpty())    params->setProperty ("keyscale", req.keyscale);
        params->setProperty ("durationSec", req.durationSec);
        if (req.seed >= 0)                params->setProperty ("seed", req.seed);
        if (req.style.isNotEmpty())       params->setProperty ("style", req.style);
        if (req.adapterId.isNotEmpty())   params->setProperty ("adapterId", req.adapterId);
        if (req.sourceAssetId.isNotEmpty()) params->setProperty ("sourceAssetId", req.sourceAssetId);
        if (req.type == "repaint_audio")
        {
            params->setProperty ("startSec", req.startSec);
            params->setProperty ("endSec", req.endSec);
        }
        if (req.type == "generate_stem" && req.arm.isNotEmpty())
            params->setProperty ("arm", req.arm);

        juce::DynamicObject::Ptr body = new juce::DynamicObject();
        body->setProperty ("type", req.type);
        body->setProperty ("params", juce::var (params.get()));
        body->setProperty ("priority", req.priority);

        juce::String response;
        if (! post ("/api/vst3/generate", juce::JSON::toString (juce::var (body.get())), response, errorOut))
            return {};

        auto v = juce::JSON::parse (response);
        auto id = v.getProperty ("taskId", {}).toString();
        if (id.isEmpty())
            errorOut = v.getProperty ("error", "提交失败").toString();
        return id;
    }

    TaskView poll (const juce::String& taskId, juce::String& errorOut) const
    {
        TaskView view;
        auto payload = getJson ("/api/vst3/tasks/" + taskId, errorOut);
        if (payload.isVoid())
            return view;
        auto t = payload.getProperty ("task", {});
        view.id = t.getProperty ("id", {}).toString();
        view.type = t.getProperty ("type", {}).toString();
        view.status = t.getProperty ("status", {}).toString();
        view.progress = (double) t.getProperty ("progress", 0);
        view.terminal = (bool) t.getProperty ("terminal", false);
        view.queuePosition = (int) t.getProperty ("queuePosition", 0);
        view.estimatedWaitSec = (double) t.getProperty ("estimatedWaitSec", 0);
        view.assetId = t.getProperty ("assetId", {}).toString();
        view.error = t.getProperty ("error", {}).toString();
        return view;
    }

    bool cancel (const juce::String& taskId) const
    {
        juce::String error, response;
        return post ("/api/vst3/tasks/" + taskId + "/cancel", "{}", response, error);
    }

    /** 下载 WAV：返回 buffer（失败为空）；durationSec 从响应头读取 */
    juce::MemoryBlock download (const juce::String& assetId, double& durationSecOut) const
    {
        juce::MemoryBlock data;
        auto url = juce::URL (baseUrl + "/api/vst3/assets/" + assetId);
        auto options = juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                           .withConnectionTimeoutMs (30000);
        auto stream = url.createInputStream (options);
        if (stream == nullptr)
            return data;
        durationSecOut = stream->getTotalLength() > 0
                             ? 0.0 // 时长以响应头为准（JUCE WebInputStream::getResponseHeaders 更直接）
                             : 0.0;
        auto size = (juce::int64) stream->getTotalLength();
        if (size <= 0)
            size = 192000 * 30; // 兜底上限
        data.setSize ((size_t) size);
        stream->read (data.getData(), (int) size);
        return data;
    }

private:
    juce::String baseUrl;

    bool post (const juce::String& path, const juce::String& jsonBody, juce::String& responseOut, juce::String& errorOut) const
    {
        auto url = juce::URL (baseUrl + path).withPOSTData (jsonBody)
                       .withParameter ("Content-Type", "application/json");
        auto stream = url.createInputStream (juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inPostData)
                                                .withExtraHeaders ("Content-Type: application/json\r\n")
                                                .withConnectionTimeoutMs (30000));
        if (stream == nullptr)
        {
            errorOut = "无法连接本地服务 " + baseUrl;
            return false;
        }
        responseOut = stream->readEntireStreamAsString();
        return true;
    }

    juce::var getJson (const juce::String& path, juce::String& errorOut) const
    {
        auto url = juce::URL (baseUrl + path);
        auto stream = url.createInputStream (juce::URL::InputStreamOptions (juce::URL::ParameterHandling::inAddress)
                                                .withConnectionTimeoutMs (15000));
        if (stream == nullptr)
        {
            errorOut = "无法连接本地服务 " + baseUrl;
            return {};
        }
        auto text = stream->readEntireStreamAsString();
        auto parsed = juce::JSON::parse (text);
        if (parsed.isVoid())
        {
            errorOut = "服务返回非 JSON";
            return {};
        }
        return parsed;
    }
};
} // namespace aiab