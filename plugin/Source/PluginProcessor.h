/**
 * ArrangementBuddy VST3 插件处理器（脚手架，未在本机编译）。
 *
 * 设计：插件是"瘦客户端"——只负责把提示词/参数提交给本地服务（/api/vst3/*），
 * 轮询任务，拿到 WAV 后在 DAW 里播放。模型推理在 Companion（GPU 机器）上。
 * 详见 docs/VST3_PLUGIN.md。
 */
#pragma once

#include <JuceHeader.h>
#include "BridgeClient.h"

class ArrangementBuddyProcessor : public juce::AudioProcessor,
                                  private juce::Timer
{
public:
    ArrangementBuddyProcessor();
    ~ArrangementBuddyProcessor() override = default;

    // ==== AudioProcessor ====
    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override {}
    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;
    void processBlock (juce::AudioBuffer<float>& buffer, juce::MidiBuffer& midi) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "ArrangementBuddy"; }
    bool acceptsMidi() const override { return false; }
    bool producesMidi() const override { return false; }
    bool isMidiEffect() const override { return false; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram (int) override {}
    const juce::String getProgramName (int) override { return "AI Gen"; }
    void changeProgramName (int, const juce::String&) override {}

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    // ==== 生成流程（UI 调用）====
    void setBaseUrl (const juce::String& url)   { bridge.setBaseUrl (url); }
    juce::String getStatusText() const          { return statusText; }
    double getTaskProgress() const              { return taskProgress; }
    bool isBusy() const                         { return currentTaskId.isNotEmpty(); }

    void generate (const aiab::GenerateRequest& request);
    void cancelGeneration();

    juce::AudioBuffer<float>& getGeneratedBuffer() { return generatedBuffer; }

private:
    struct ParamIds
    {
        static constexpr const char* prompt = "prompt";
        static constexpr const char* bpm = "bpm";
        static constexpr const char* duration = "duration";
        static constexpr const char* priority = "priority";
        static constexpr const char* arm = "arm";
    };

    void timerCallback() override;
    void setStatus (const juce::String& text, double progress = -1.0);
    void updatePlaybackRate (double projectBpm);

    aiab::BridgeClient bridge;
    juce::String currentTaskId;
    juce::String statusText { "就绪：连接本地服务后即可生成" };
    double taskProgress = 0.0;
    double fileSampleRate = 48000.0;
    double projectBpm = 120.0;
    double playbackPos = 0.0;
    bool playing = false;

    juce::AudioBuffer<float> generatedBuffer;
    juce::AudioParameterFloat* bpmParam = nullptr;
    juce::AudioParameterFloat* durationParam = nullptr;
    juce::AudioParameterInt* priorityParam = nullptr;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (ArrangementBuddyProcessor)
};