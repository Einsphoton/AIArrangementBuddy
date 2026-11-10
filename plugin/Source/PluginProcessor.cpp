#include "PluginProcessor.h"
#include "PluginEditor.h"

ArrangementBuddyProcessor::ArrangementBuddyProcessor()
    : AudioProcessor (BusesProperties().withOutput ("Output", juce::AudioChannelSet::stereo(), true))
{
    addParameter (bpmParam = new juce::AudioParameterFloat (
                      "bpm", "BPM",
                      juce::NormalisableRange<float> (40.0f, 240.0f, 1.0f), 120.0f));
    addParameter (durationParam = new juce::AudioParameterFloat (
                      "duration", "时长（秒）", juce::NormalisableRange<float> (5.0f, 120.0f, 1.0f), 20.0f));
    addParameter (priorityParam = new juce::AudioParameterInt ("priority", "优先级", 0, 2, 0));
    startTimer (500);
}

void ArrangementBuddyProcessor::prepareToPlay (double sampleRate, int)
{
    fileSampleRate = sampleRate;
    generatedBuffer.setSize (2, (int) (sampleRate * 120), false, true, false);
    generatedBuffer.clear();
}

bool ArrangementBuddyProcessor::isBusesLayoutSupported (const BusesLayout& layouts) const
{
    const auto& out = layouts.getMainOutputChannelSet();
    return out == juce::AudioChannelSet::stereo() || out == juce::AudioChannelSet::mono();
}

void ArrangementBuddyProcessor::processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer&)
{
    juce::ScopedNoDenormals noDenormals;
    buffer.clear();
    if (! playing || generatedBuffer.getNumSamples() == 0)
        return;

    const int n = buffer.getNumSamples();
    for (int ch = 0; ch < juce::jmin (2, generatedBuffer.getNumChannels()); ++ch)
    {
        // 简单循环播放；按工程 BPM 对齐由 UI/宿主决定，插件内不做时间拉伸（与产品一致）
        auto* dst = buffer.getWritePointer (ch);
        auto* src = generatedBuffer.getReadPointer (ch);
        for (int i = 0; i < n; ++i)
        {
            dst[i] = src[(size_t) playbackPos % (size_t) generatedBuffer.getNumSamples()];
            if (ch == 0) ++playbackPos;
        }
        playbackPos = std::fmod (playbackPos, (double) generatedBuffer.getNumSamples());
    }
}

void ArrangementBuddyProcessor::generate (const aiab::GenerateRequest& request)
{
    juce::String error;
    const int workers = bridge.hello (error);
    if (workers < 0)
    {
        setStatus ("无法连接本地服务：" + error, 0.0);
        return;
    }
    if (workers == 0)
    {
        setStatus ("没有在线 Companion（GPU 机器上需启动 scripts/companion.mjs）", 0.0);
        return;
    }
    const auto id = bridge.submit (request, error);
    if (id.isEmpty())
    {
        setStatus ("提交失败：" + error, 0.0);
        return;
    }
    currentTaskId = id;
    setStatus ("已提交任务 " + id.left (12) + "…，等待 Companion", 0.05);
}

void ArrangementBuddyProcessor::cancelGeneration()
{
    if (currentTaskId.isNotEmpty())
        bridge.cancel (currentTaskId);
    currentTaskId.clear();
    playing = false;
    setStatus ("已取消", 0.0);
}

void ArrangementBuddyProcessor::timerCallback()
{
    if (currentTaskId.isEmpty())
        return;
    juce::String error;
    const auto view = bridge.poll (currentTaskId, error);
    if (view.id.isEmpty())
    {
        setStatus ("轮询失败：" + error, taskProgress);
        return;
    }
    taskProgress = view.progress;
    if (! view.terminal)
    {
        auto text = "任务 " + view.status + " · " + juce::String ((int) (view.progress * 100)) + "%";
        if (view.queuePosition > 0)
            text << " · 排队第 " << view.queuePosition << " 位";
        if (view.estimatedWaitSec > 0)
            text << " · 约 " << juce::String ((int) view.estimatedWaitSec) << "s";
        setStatus (text, view.progress);
        return;
    }

    currentTaskId.clear();
    if (view.status != "done" || view.assetId.isEmpty())
    {
        setStatus ("任务失败：" + (view.error.isNotEmpty() ? view.error : view.status), 0.0);
        return;
    }

    double unusedDuration = 0.0;
    auto wav = bridge.download (view.assetId, unusedDuration);
    if (wav.getSize() == 0)
    {
        setStatus ("下载产物失败", 0.0);
        return;
    }
    // 解析 WAV（JUCE 内置），失败给可读错误
    juce::WavAudioFormat format;
    std::unique_ptr<juce::AudioFormatReader> reader (
        format.createReaderFor (new juce::MemoryInputStream (wav, false), true));
    if (reader == nullptr)
    {
        setStatus ("产物不是合法 WAV", 0.0);
        return;
    }
    const int samples = (int) reader->lengthInSamples;
    generatedBuffer.setSize (2, samples, false, true, false);
    reader->read (&generatedBuffer, 0, samples, 0, true, true);
    fileSampleRate = reader->sampleRate;
    setStatus ("生成完成：" + juce::String (samples / fileSampleRate, 1) + "s，按播放键试听或导出", 1.0);
}

void ArrangementBuddyProcessor::setStatus (const juce::String& text, double progress)
{
    statusText = text;
    if (progress >= 0.0)
        taskProgress = progress;
}

void ArrangementBuddyProcessor::getStateInformation (juce::MemoryBlock& destData)
{
    juce::DynamicObject::Ptr state = new juce::DynamicObject();
    state->setProperty ("baseUrl", bridge.getBaseUrl());
    state->setProperty ("bpm", bpmParam->get());
    state->setProperty ("duration", durationParam->get());
    state->setProperty ("priority", priorityParam->get());
    auto text = juce::JSON::toString (juce::var (state.get()));
    destData.replaceAll (text.toRawUTF8(), text.getNumBytesAsUTF8());
}

void ArrangementBuddyProcessor::setStateInformation (const void* data, int size)
{
    auto text = juce::String::fromUTF8 (static_cast<const char*> (data), size);
    auto parsed = juce::JSON::parse (text);
    if (auto* obj = parsed.getDynamicObject())
    {
        if (auto url = obj->getProperty ("baseUrl").toString(); url.isNotEmpty())
            bridge.setBaseUrl (url);
        bpmParam->setValueNotifyingHost (
            bpmParam->convertTo0to1 ((float) (double) obj->getProperty ("bpm")));
        durationParam->setValueNotifyingHost (
            durationParam->convertTo0to1 ((float) (double) obj->getProperty ("duration")));
        priorityParam->setValueNotifyingHost (
            priorityParam->convertTo0to1 ((float) (int) obj->getProperty ("priority")));
    }
}

juce::AudioProcessorEditor* ArrangementBuddyProcessor::createEditor()
{
    return new ArrangementBuddyEditor (*this);
}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new ArrangementBuddyProcessor();
}