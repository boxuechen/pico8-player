pico-8 cartridge // http://www.pico-8.com
version 42
__lua__
local samples={}
local sample_count=8
local next_sample=2

-- Capture top-level, _init, then the first six _update() clock values.
samples[0]=flr(time()*30+0.5)

function _init()
 samples[1]=flr(time()*30+0.5)
end

function _update()
 if next_sample<sample_count then
  samples[next_sample]=flr(time()*30+0.5)
  next_sample+=1
 end
end

function _draw()
 if next_sample<sample_count then return end
 cls(0)
 for row=0,sample_count-1 do
  local value=samples[row]
  for bit=0,7 do
   if band(value,shl(1,bit))~=0 then
    rectfill(bit*4,row*4,bit*4+3,row*4+3,7)
   end
  end
  rectfill(60,row*4,63,row*4+3,8)
 end
 rectfill(60,60,63,63,11)
end
